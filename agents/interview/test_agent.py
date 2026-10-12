import hashlib
import hmac
import json
import time
import unittest
import uuid
from unittest.mock import AsyncMock

import httpx
from agent import Callback, QuestionFlow, settings, validate_job

ENV = {
    "LIVEKIT_URL": "wss://test.livekit.cloud",
    "LIVEKIT_API_KEY": "test",
    "LIVEKIT_API_SECRET": "test",
    "INTERVIEW_ENGINE_AGENT_NAME": "test",
    "LIVEKIT_AGENT_CALLBACK_SECRET": "synthetic-callback-secret-only",
    "LLM_PROVIDER": "openrouter",
    "LLM_MODEL": "configured/model",
    "OPENROUTER_API_KEY": "synthetic",
    "PUBLIC_APP_URL": "https://arkoffer.example",
}


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def test_settings_preserve_gateway_and_model(self):
        config = settings(ENV)
        self.assertEqual(config["model"], "configured/model")
        self.assertEqual(config["base"], "https://openrouter.ai/api/v1")
        self.assertEqual(config["speech"], "livekit")
        self.assertEqual(
            config["callback"], "https://arkoffer.example/api/live-interviews/callback"
        )
        with self.assertRaises(ValueError):
            settings({**ENV, "OPENROUTER_API_BASE_URL": "https://user:secret@host/v1"})
        with self.assertRaises(ValueError):
            settings({**ENV, "LIVEKIT_API_KEY": ""})

    def test_dispatch_rejects_private_fields_and_untrusted_callback(self):
        config = settings(ENV)
        session = str(uuid.uuid4())
        data = {
            "version": 1,
            "sessionId": session,
            "candidateIdentity": "candidate-" + session,
            "callbackUrl": config["callback"],
            "expiresAt": int(time.time() * 1000) + 60000,
            "questions": [
                {
                    "id": str(uuid.uuid4()),
                    "prompt": "Describe a project.",
                    "type": "text",
                    "options": [],
                    "required": True,
                }
            ],
        }
        self.assertEqual(validate_job(json.dumps(data), config)["sessionId"], session)
        with self.assertRaises(ValueError):
            validate_job(
                json.dumps({**data, "callbackUrl": "http://127.0.0.1/private"}), config
            )
        data["questions"][0]["rubric"] = "Private rubric"
        with self.assertRaises(ValueError):
            validate_job(json.dumps(data), config)

    async def test_callback_signs_exact_unicode_bytes_and_serializes_events(self):
        config = settings(ENV)
        received = []

        async def handle(request):
            stamp = request.headers["X-ArkOffer-Timestamp"]
            expected = hmac.new(
                config["secret"].encode(),
                stamp.encode() + b"." + request.content,
                hashlib.sha256,
            ).hexdigest()
            self.assertEqual(request.headers["X-ArkOffer-Signature"], expected)
            received.append(json.loads(request.content))
            return httpx.Response(200, json={"ok": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            callback = Callback(config, str(uuid.uuid4()), client)
            await callback.send("answer", str(uuid.uuid4()), "J’ai créé une API.")
            await callback.send("ended")
        self.assertEqual([event["sequence"] for event in received], [1, 2])
        self.assertEqual(received[0]["text"], "J’ai créé une API.")

    async def test_flow_records_only_candidate_transcript_and_preserves_question_ids(
        self,
    ):
        callback = AsyncMock()
        questions = [
            {
                "id": str(uuid.uuid4()),
                "prompt": "Describe a project.",
                "type": "text",
                "options": [],
            },
            {
                "id": str(uuid.uuid4()),
                "prompt": "Can you use TypeScript?",
                "type": "yes-no",
                "options": [],
            },
        ]
        flow = QuestionFlow(questions, callback)
        repeated = await flow.spoken_answer("repeat")
        self.assertEqual(repeated[0], questions[0]["id"])
        callback.send.assert_not_called()
        next_question = await flow.spoken_answer("I built a search service.")
        callback.send.assert_awaited_once_with(
            "answer", questions[0]["id"], "I built a search service."
        )
        self.assertEqual(next_question[0], questions[1]["id"])
        self.assertIsNone(await flow.spoken_answer("Yes."))
        self.assertEqual(callback.send.await_count, 2)
        self.assertIsNone(await flow.spoken_answer("No invented third answer"))
        self.assertEqual(callback.send.await_count, 2)

    async def test_callback_rejection_cannot_silently_advance_question(self):
        callback = AsyncMock()
        callback.send.side_effect = RuntimeError("not saved")
        flow = QuestionFlow(
            [
                {
                    "id": str(uuid.uuid4()),
                    "prompt": "Experience?",
                    "type": "text",
                    "options": [],
                }
            ],
            callback,
        )
        with self.assertRaises(RuntimeError):
            await flow.spoken_answer("My answer")
        self.assertEqual(flow.index, 0)


if __name__ == "__main__":
    unittest.main()
