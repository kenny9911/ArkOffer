# ArkOffer live interviewer

A separately running LiveKit Agents service conducts the **published questions** in order, speaks responses using TTS, and saves the candidate's actual STT transcript through authenticated ArkOffer callbacks. Camera presence is supported in the room; camera frames are not passed to the LLM. No audio/video recording is stored. Candidates end the session, review/edit transcribed answers, and manually submit. This service does not evaluate, rank, or make decisions about candidates.

## Run

Use Python 3.13 (supported versions are defined by the pinned SDK):

```sh
python3.13 -m venv agents/interview/.venv
agents/interview/.venv/bin/pip install -r agents/interview/requirements.txt
agents/interview/.venv/bin/python agents/interview/agent.py download-files
agents/interview/.venv/bin/python agents/interview/agent.py start
```

The service reads the repository `.env` without overwriting process values. Run the API and this agent together; the callback URL must be reachable from the agent. The same deployment must supply these settings to both:

- `LIVEKIT_URL` (`wss://…`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- `INTERVIEW_ENGINE_AGENT_NAME`, the explicit dispatch name. The API and agent must agree.
- `LIVEKIT_AGENT_CALLBACK_SECRET`, at least 24 characters, used only server-side.
- `INTERVIEW_AGENT_CALLBACK_URL`, or an exact `PUBLIC_APP_URL`, `APP_URL`, or single `APP_ORIGIN` from which `/api/live-interviews/callback` is derived. HTTPS is required except localhost development.
- `LIVEKIT_WORKSPACE_IDS`, or existing `LLM_WORKSPACE_IDS`/`OPENAI_WORKSPACE_IDS`, listing authorized workspace UUIDs.
- The existing `LLM_PROVIDER` (`openai` or `openrouter`), appropriate API key, and `LLM_INTERVIEW_MODEL` or `LLM_MODEL`. Provider base URL aliases and configured reasoning effort follow the ArkOffer text adapter. No replacement text model is selected by the agent.

On LiveKit Cloud, speech defaults to LiveKit Inference (`INTERVIEW_VOICE_PROVIDER=livekit`). STT uses `auto` for the screening language. TTS uses `fishaudio/s2.1-pro` with voice `fa4c9eb3dccc4806b382b40d61c6b10a`. Override with `INTERVIEW_STT_MODEL`, `INTERVIEW_TTS_MODEL`, and `INTERVIEW_TTS_VOICE` as appropriate for the account/language. These inference services incur provider usage.

For self-hosted LiveKit, use `INTERVIEW_VOICE_PROVIDER=openai` and configure `OPENAI_API_KEY`. STT respects `OPENAI_TRANSCRIPTION_MODEL` and `OPENAI_TRANSCRIPTION_BASE_URL`; TTS respects `INTERVIEW_TTS_MODEL`, `INTERVIEW_TTS_VOICE`, and `OPENAI_TTS_BASE_URL`. The default speech models are `gpt-4o-mini-transcribe` and `gpt-4o-mini-tts` (voice `ash`). OpenRouter text credentials do not supply OpenAI speech access.

Select **Live AI interview** in the screening builder. Publication/invitations fail closed when the API reports missing configuration. Configuration checks do not establish that a named agent is deployed or a speech model is enabled on the provider account: verify those in a synthetic staging interview before inviting candidates. An interviewer that never becomes ready is closed after 60 seconds; sessions also end after 30 minutes, expiry, revocation, submission, or API shutdown. An expired short-lived token alone does not disconnect a participant; the API room cleanup and agent duration bound enforce this.

The agent asks one question per completed spoken turn. Say “repeat” to hear the current question again. It uses the configured LLM for a short neutral acknowledgement, appends the exact next question in code, and preserves answer-to-question identity without model classification. Pause/end detection depends on the configured STT/VAD. Candidates can correct transcription and answer-choice interpretation in the form. Automatic clarification, persistent video recordings, and recruiter live attendance are not implemented by this runner.

## Test without microphone, credentials or provider calls

```sh
cd agents/interview
.venv/bin/python -m unittest -v test_agent
```

The Node integration tests mock only the LiveKit provider boundary; they exercise publication authorization, camera/consent validation, signed callbacks, replay/order checks, transcript evidence, revocation and manual submission. Python tests cover exact-byte HMAC callbacks, public dispatch validation, provider/model settings and deterministic question identity. Live room and speech verification requires configured credentials and a deployed agent.

References: [LiveKit explicit dispatch](https://docs.livekit.io/agents/server/agent-dispatch/), [sessions](https://docs.livekit.io/agents/logic/sessions/), [pipeline hooks](https://docs.livekit.io/agents/logic/nodes/), [OpenAI-compatible LLMs](https://docs.livekit.io/agents/models/llm/openai-compatible-llms/), [STT](https://docs.livekit.io/agents/models/stt/), [TTS](https://docs.livekit.io/agents/models/tts/), [server SDK](https://docs.livekit.io/reference/server-sdk-js/).
