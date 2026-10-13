"""ArkOffer's explicitly dispatched LiveKit interviewer. Never scores candidates."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import time
import uuid
from pathlib import Path
from collections.abc import Awaitable, Callable
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    AutoSubscribe,
    JobContext,
    inference,
    llm,
    room_io,
)
from livekit.plugins import openai, silero

from adaptive import AdaptiveFollowUps

# Read the existing project configuration without replacing process/deployment values.
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


def secure_url(value: str, *, localhost: bool = False) -> str:
    parsed = urlparse(value)
    if (
        parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not parsed.hostname
    ):
        raise ValueError("Invalid provider URL")
    if parsed.scheme != "https" and not (
        localhost
        and parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1"}
    ):
        raise ValueError("A secure provider URL is required")
    return value.rstrip("/")


def settings(env: dict[str, str]) -> dict:
    provider = env.get("LLM_PROVIDER", "openai").strip().lower()
    if provider not in {"openai", "openrouter"}:
        raise ValueError("LLM_PROVIDER must be openai or openrouter")
    key = env.get(
        "OPENROUTER_API_KEY" if provider == "openrouter" else "OPENAI_API_KEY", ""
    ).strip()
    model = (
        env.get("LLM_INTERVIEW_MODEL")
        or env.get("LLM_MODEL")
        or (env.get("OPENAI_MODEL") if provider == "openai" else "")
        or ""
    ).strip()
    base = (
        (
            env.get("OPENROUTER_API_BASE_URL")
            or env.get("OPENROUTER_BASE_URL")
            or "https://openrouter.ai/api/v1"
        )
        if provider == "openrouter"
        else (env.get("OPENAI_BASE_URL") or "https://api.openai.com/v1")
    )
    callback = (
        env.get("INTERVIEW_AGENT_CALLBACK_URL")
        or (
            env.get("PUBLIC_APP_URL") or env.get("APP_URL") or env.get("APP_ORIGIN", "")
        ).rstrip("/")
        + "/api/live-interviews/callback"
    )
    secret = env.get("LIVEKIT_AGENT_CALLBACK_SECRET", "")
    if (
        not key
        or not model
        or len(secret) < 24
        or not env.get("INTERVIEW_ENGINE_AGENT_NAME")
    ):
        raise ValueError(
            "Configure the interview model, provider credentials, callback secret, and agent name"
        )
    livekit_url = urlparse(env.get("LIVEKIT_URL", ""))
    if (
        livekit_url.scheme != "wss"
        or not env.get("LIVEKIT_API_KEY")
        or not env.get("LIVEKIT_API_SECRET")
    ):
        raise ValueError("Configure secure LiveKit credentials")
    cloud = (livekit_url.hostname or "").endswith(".livekit.cloud")
    speech = env.get("INTERVIEW_VOICE_PROVIDER") or ("livekit" if cloud else "openai")
    if (
        speech not in {"livekit", "openai"}
        or (speech == "livekit" and not cloud)
        or (speech == "openai" and not env.get("OPENAI_API_KEY"))
    ):
        raise ValueError(
            "Configure LiveKit Cloud inference or OpenAI speech credentials"
        )
    effort = env.get("LLM_INTERVIEW_REASONING_EFFORT") or env.get(
        "LLM_REASONING_EFFORT"
    )
    if effort and effort not in {
        "provider",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    }:
        raise ValueError("Unsupported interview reasoning effort")
    return {
        "provider": provider,
        "key": key,
        "model": model,
        "base": secure_url(base),
        "callback": secure_url(callback, localhost=True),
        "secret": secret,
        "speech": speech,
        "effort": effort,
    }


def validate_job(raw: str, config: dict) -> dict:
    data = json.loads(raw)
    if data.get("version") != 1 or data.get("callbackUrl") != config["callback"]:
        raise ValueError("Unrecognized interview dispatch")
    session_id = str(uuid.UUID(data["sessionId"]))
    if data.get("candidateIdentity") != "candidate-" + session_id:
        raise ValueError("Candidate identity mismatch")
    if not 0 < data["expiresAt"] / 1000 - time.time() <= 1800:
        raise ValueError("Interview dispatch expired")
    if any(
        not isinstance(data.get(field, ""), str) or len(data.get(field, "")) > 5000
        for field in ("welcomeMessage", "completionMessage")
    ):
        raise ValueError("Invalid published screening message")
    questions = data.get("questions", [])
    if not 1 <= len(questions) <= 50:
        raise ValueError("Invalid interview questions")
    seen = set()
    for question in questions:
        identity = str(uuid.UUID(question["id"]))
        if (
            identity in seen
            or not 1 <= len(question["prompt"]) <= 2000
            or question["type"] not in {"text", "yes-no", "multiple-choice"}
        ):
            raise ValueError("Invalid interview question")
        seen.add(identity)
        if "followUp" in question and not isinstance(question["followUp"], bool):
            raise ValueError("Invalid follow-up setting")
        if set(question) - {"id", "prompt", "type", "options", "required", "followUp"}:
            raise ValueError("Private or unsupported question fields")
    return data


def speech_timing(metrics: dict, source: str) -> dict | None:
    """SDK speech bounds only; creation/receipt times are never media evidence."""
    start, end = metrics.get("started_speaking_at"), metrics.get("stopped_speaking_at")
    if any(isinstance(value, bool) or not isinstance(value, (float, int))
           or not math.isfinite(value) for value in (start, end)):
        return None
    if not 0 < start < end or end - start > 1800:
        return None
    return {"source": source, "startedAtMs": round(start * 1000),
            "endedAtMs": round(end * 1000)}


class Callback:
    """Ordered, authenticated, idempotent events; no transcript in query strings/logs."""

    def __init__(self, config: dict, session_id: str, client: httpx.AsyncClient):
        self.config, self.session_id, self.client = config, session_id, client
        self.sequence = 0
        self.lock = asyncio.Lock()

    async def send(
        self, kind: str, question_id: str | None = None, text: str | None = None,
        *, timing: dict | None = None
    ):
        async with self.lock:
            payload = {
                "eventId": str(uuid.uuid4()),
                "sessionId": self.session_id,
                "sequence": self.sequence + 1,
                "kind": kind,
            }
            if question_id is not None:
                payload["questionId"] = question_id
            if text is not None:
                payload["text"] = text
            if timing is not None:
                payload["timing"] = timing
            body = json.dumps(
                payload, separators=(",", ":"), ensure_ascii=False
            ).encode()
            for attempt in range(3):
                stamp = str(int(time.time() * 1000))
                signature = hmac.new(
                    self.config["secret"].encode(),
                    stamp.encode() + b"." + body,
                    hashlib.sha256,
                ).hexdigest()
                try:
                    response = await self.client.post(
                        self.config["callback"],
                        content=body,
                        headers={
                            "Content-Type": "application/json",
                            "X-ArkOffer-Timestamp": stamp,
                            "X-ArkOffer-Signature": signature,
                        },
                    )
                    if response.status_code < 500:
                        response.raise_for_status()
                        self.sequence += 1
                        return
                except httpx.TransportError:
                    pass
                if attempt < 2:
                    await asyncio.sleep(0.5 * (attempt + 1))
            raise RuntimeError("Interview evidence could not be saved")


class QuestionFlow:
    """Question identity is owned by the program, never inferred or invented by a model."""

    def __init__(
        self,
        questions: list[dict],
        callback: Callback,
        followups: AdaptiveFollowUps | None = None,
        speak: Callable[[str], Awaitable[dict | None]] | None = None,
    ):
        self.questions, self.callback, self.index = questions, callback, 0
        self.followups, self.speak = followups, speak
        self.followup_prompt: str | None = None
        self.attempted: set[str] = set()
        self.prompt_already_recorded = False
        self.lock = asyncio.Lock()

    def prompt(self) -> str:
        if self.followup_prompt is not None:
            return self.followup_prompt
        question = self.questions[self.index]
        text = question["prompt"]
        if question["type"] == "yes-no":
            text += " Please answer yes or no."
        elif question["type"] == "multiple-choice":
            text += " Choose one: " + "; ".join(question["options"]) + "."
        return text

    async def spoken_answer(self, text: str, timing: dict | None = None) -> tuple[str, str] | None:
        self.prompt_already_recorded = False
        timing_args = {"timing": timing} if timing is not None else {}
        if not text.strip() or self.index >= len(self.questions):
            return None
        question = self.questions[self.index]
        command = text.strip().lower().rstrip(".?!。？！")
        if command in {
            "repeat",
            "repeat the question",
            "please repeat the question",
            "repetir",
            "répéter",
            "wiederholen",
            "repita",
            "重复",
            "繰り返して",
        }:
            return question["id"], self.prompt()
        if command in {
            "skip",
            "skip the question",
            "please skip the question",
            "skip this question",
            "skip this",
            "next question",
            "saltar",
            "passer",
            "überspringen",
            "pular",
            "跳过",
            "スキップ",
        }:
            await self.callback.send(
                "followup-skip" if self.followup_prompt else "skip",
                question["id"],
                text.strip(),
                **timing_args,
            )
            self.followup_prompt = None
            return self.advance()
        # This is the STT result itself. No LLM-generated answer is accepted or stored.
        await self.callback.send(
            "followup-answer" if self.followup_prompt else "answer",
            question["id"],
            text.strip(),
            **timing_args,
        )
        if self.followup_prompt is not None:
            self.followup_prompt = None
            return self.advance()
        if (
            self.followups is not None
            and question.get("type") == "text"
            and question.get("followUp") is True
            and question["id"] not in self.attempted
        ):
            # Attempted is set before awaiting. Repeat, timeout or malformed
            # output can never replenish the one-attempt-per-question budget.
            self.attempted.add(question["id"])
            try:
                prompt = await self.followups.generate(question, text.strip())
            except Exception:
                prompt = None
            if prompt is not None:
                spoken = await self.speak(prompt) if self.speak else None
                await self.callback.send("followup-question", question["id"], prompt,
                                         **({"timing": spoken} if spoken else {}))
                self.followup_prompt = prompt
                self.prompt_already_recorded = True
                return question["id"], prompt
        return self.advance()

    def advance(self) -> tuple[str, str] | None:
        self.index += 1
        if self.index == len(self.questions):
            return None
        return self.questions[self.index]["id"], self.prompt()


class Interviewer(Agent):
    def __init__(self, job: dict, callback: Callback, model: openai.LLM):
        super().__init__(
            instructions="Conduct the published screening. Never score, rank or make a hiring decision. Never evaluate appearance, emotion, disability or other protected traits."
        )
        self.job, self.callback, self.model = job, callback, model
        self.flow = QuestionFlow(
            job["questions"],
            callback,
            AdaptiveFollowUps(model, language=job.get("language", "en-US")),
            self.speak,
        )

    async def speak(self, text: str) -> dict | None:
        handle = self.session.say(text, allow_interruptions=False)
        await handle
        # SpeechHandle.chat_items is populated after actual audio playout. The
        # message's created_at is deliberately not used as a substitute.
        messages = [item for item in getattr(handle, "chat_items", [])
                    if isinstance(item, llm.ChatMessage) and item.role == "assistant"]
        if hasattr(handle, "chat_items") and (not messages or
            any(item.interrupted for item in messages) or
            "".join(item.text_content or "" for item in messages).strip() != text.strip()):
            # Shutdown can interrupt even non-interruptible prompts. Do not bind
            # the entire planned question to a partial or absent spoken message.
            raise RuntimeError("Interview prompt did not complete")
        bounds = [speech_timing(item.metrics, "livekit-playout") for item in messages]
        known = [bound for bound in bounds if bound is not None]
        if not known:
            return None
        return {"source": "livekit-playout",
                "startedAtMs": min(bound["startedAtMs"] for bound in known),
                "endedAtMs": max(bound["endedAtMs"] for bound in known)}

    async def record_prompt(self, identity: str, text: str):
        timing = await self.speak(text)
        await self.callback.send("agent", identity, text,
                                 **({"timing": timing} if timing else {}))

    async def on_enter(self):
        await self.callback.send("ready")
        text = (
            (
                self.job.get("welcomeMessage")
                or "Welcome. I will ask one question at a time. Pause when you have finished your answer. You can end the interview at any time and review or edit the transcript before submitting."
            )
            + " Say repeat to hear the current question again, or skip to move to the next question. "
            + self.flow.prompt()
        )
        await self.record_prompt(self.flow.questions[0]["id"], text)

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ):
        text = new_message.text_content or ""
        if not text.strip():
            raise llm.StopResponse()
        async with self.flow.lock:
            try:
                next_question = await self.flow.spoken_answer(
                    text, speech_timing(new_message.metrics, "livekit-vad")
                )
                if next_question is None:
                    await self.session.say(
                        self.job.get("completionMessage")
                        or "Thank you. Please review the transcript and your answers on the page, then choose Submit responses when you are ready.",
                        allow_interruptions=False,
                    )
                    await self.callback.send("ended")
                    self.session.shutdown()
                else:
                    identity, prompt = next_question
                    # Published questions are exact. Adaptive questions come from
                    # authored neutral templates, never raw model-generated speech.
                    if not self.flow.prompt_already_recorded:
                        await self.record_prompt(identity, prompt)
            except Exception:
                self.session.shutdown(drain=False)
                raise
        raise llm.StopResponse()


server = AgentServer()


@server.rtc_session(
    agent_name=os.getenv("INTERVIEW_ENGINE_AGENT_NAME", "arkoffer-interviewer")
)
async def interview(ctx: JobContext):
    config = settings(dict(os.environ))
    job = validate_job(ctx.job.metadata, config)
    language = job.get("language", "en-US").split("-")[0]
    model_options = {
        "model": config["model"],
        "api_key": config["key"],
        "base_url": config["base"],
        "max_completion_tokens": 256,
        "max_retries": 0,
    }
    if config["effort"] and config["effort"] != "provider":
        if config["provider"] == "openrouter":
            model_options["extra_body"] = {"reasoning": {"effort": config["effort"]}}
        else:
            model_options["reasoning_effort"] = config["effort"]
    model = openai.LLM(**model_options)
    if config["speech"] == "livekit":
        stt = inference.STT(
            model=os.getenv("INTERVIEW_STT_MODEL") or "auto", language=language
        )
        tts = inference.TTS(
            model=os.getenv("INTERVIEW_TTS_MODEL") or "fishaudio/s2.1-pro",
            voice=os.getenv("INTERVIEW_TTS_VOICE")
            or "fa4c9eb3dccc4806b382b40d61c6b10a",
            language=language,
        )
    else:
        stt = openai.STT(
            model=os.getenv("OPENAI_TRANSCRIPTION_MODEL") or "gpt-4o-mini-transcribe",
            language=language,
            base_url=secure_url(
                os.getenv("OPENAI_TRANSCRIPTION_BASE_URL")
                or "https://api.openai.com/v1"
            ),
            api_key=os.environ["OPENAI_API_KEY"],
        )
        tts = openai.TTS(
            model=os.getenv("INTERVIEW_TTS_MODEL") or "gpt-4o-mini-tts",
            voice=os.getenv("INTERVIEW_TTS_VOICE") or "ash",
            base_url=secure_url(
                os.getenv("OPENAI_TTS_BASE_URL") or "https://api.openai.com/v1"
            ),
            api_key=os.environ["OPENAI_API_KEY"],
        )
    session = AgentSession(
        stt=stt,
        tts=tts,
        llm=model,
        vad=silero.VAD.load(),
        video_sampler=None,
        allow_interruptions=False,
        min_endpointing_delay=1.5,
        max_endpointing_delay=3.0,
        transcription_timeout=10,
        user_away_timeout=90,
    )
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
        callback = Callback(config, job["sessionId"], client)
        ended = asyncio.Event()

        @session.on("close")
        def on_close(_):
            ended.set()

        @session.on("error")
        def on_error(_):
            session.shutdown(drain=False)

        @session.on("user_state_changed")
        def on_state(event):
            if event.new_state == "away":
                session.shutdown()

        try:
            await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
            await asyncio.wait_for(
                ctx.wait_for_participant(identity=job["candidateIdentity"]), timeout=45
            )
            await session.start(
                agent=Interviewer(job, callback, model),
                room=ctx.room,
                record=False,
                room_options=room_io.RoomOptions(
                    participant_identity=job["candidateIdentity"],
                    text_input=False,
                    video_input=False,
                    close_on_disconnect=True,
                ),
            )
            await asyncio.wait_for(
                ended.wait(), timeout=max(1, job["expiresAt"] / 1000 - time.time())
            )
        except Exception:
            try:
                await callback.send("error")
            except Exception:
                pass
        finally:
            session.shutdown(drain=False)
            await session.aclose()
            try:
                await callback.send("ended")
            except Exception:
                pass
            await model.aclose()
            ctx.shutdown(reason="Interview ended")


if __name__ == "__main__":
    # Do not log job metadata, candidate transcripts, or provider credentials.
    for name in ("livekit.agents", "livekit.plugins.openai", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    settings(dict(os.environ))
    agents.cli.run_app(server)
