# Alexa interaction model

`interaction-model.json` is the skill's voice front end. It is not deployed by
this repo — paste it into the Alexa Developer Console by hand.

## Why this file exists

Every utterance used to need a "tell me" in front of it, on every turn, even
with the mic already open. That is not a bug in the Node service. It comes from
the slot type the intent was built on:

**Alexa refuses to build a model where an `AMAZON.SearchQuery` slot appears in a
sample utterance without a carrier phrase.** `"tell me {query}"` is accepted;
`"{query}"` is rejected. So with `AMAZON.SearchQuery` there is no way to say a
bare sentence — the carrier phrase is mandatory, forever, on every turn.

This model uses a **custom slot type** (`CatchAllPhrase`) instead. Custom slot
values are hints rather than a closed set, so Alexa still returns whatever was
actually said — but a bare `"{query}"` sample is allowed. That is the whole fix.

The trade-off is real: a custom catch-all is less reliable than
`AMAZON.SearchQuery` at capturing long free-form speech, because the recogniser
leans on the example values. `CatchAllPhrase` is therefore seeded with 28 long,
varied phrases drawn from what this skill is actually used for. **If utterances
start getting clipped after a couple of words, add more long examples to that
list** — that is the knob to turn.

## Why AMAZON.FallbackIntent is not in this model

It used to be. It is left out on purpose, and adding it back will bring the
problem straight back.

`AMAZON.FallbackIntent` exists to catch "nothing matched". `AskIntent` is built
to match everything. With both in the model they compete for every single
utterance, and the short ones lose: "thank you" resembles none of the long
example phrases, so Alexa scores it as a poor match and routes it to the
fallback — which arrives at the service carrying **no transcript at all**. The
words are gone before any code here runs. That is what produced this, on every
turn:

```
[WARN] [TURN] no query extracted intent=AMAZON.FallbackIntent
[SAY ] "Sorry, I missed that. Could you say it again?"
```

Without `AMAZON.FallbackIntent` in the model, those utterances have nowhere else
to go and land in `AskIntent` with the text intact.

If you would rather keep it — it is optional, not required for certification —
then turn its sensitivity down instead, by adding this as a sibling of
`intents` and `types`:

```json
"modelConfiguration": {
  "fallbackIntentSensitivity": { "level": "LOW" }
}
```

That reduces how eagerly it fires, but it does not eliminate the contention.
Leaving the intent out is the reliable fix.

## Deploying it

1. Alexa Developer Console → your skill → **Build** → **Interaction Model** →
   **JSON Editor**.
2. Replace the whole document with `interaction-model.json`.
3. Check `invocationName` matches the invocation name the skill already has.
   This file says **"pluto"**, taken from the skill's own launch greeting; if
   yours differs, change it here rather than in the console, so the two stay in
   step.
4. **Save Model**, then **Build Model**. Wait for the build to finish.
5. Endpoint is unchanged — it still points at the tunnel to this service.

## Checking whether it is actually live

The service logs the intent name on every turn, which is the fastest way to
tell a stale model from a real problem:

- `intent=AskIntent` — the model is deployed and matching. Good.
- `intent=AMAZON.FallbackIntent` — the utterance never reached `AskIntent`.
  Either the build has not been deployed yet, or `AMAZON.FallbackIntent` is
  still in the model. Check the console shows **Build Successful** for the
  current model, then re-test.

A run of fallbacks is answered with "try saying tell me, and then what you
want" after the first one. That phrasing matches on the old model too, so it is
a way out of the loop rather than a fix — if you are hearing it, the model
above still needs deploying.

## What the service expects from it

- **Intent name does not matter.** `alexaRoutes.js` never looks at it for the
  ask path; it takes the first slot that has a value. Renaming `AskIntent` is
  safe.
- **The five built-ins must stay.** `AMAZON.StopIntent` and
  `AMAZON.CancelIntent` end the session, `AMAZON.HelpIntent` speaks the help
  line, and `AMAZON.FallbackIntent` asks the user to repeat. They arrive with
  no slots and no transcript, so the service dispatches them by name — remove
  them and "stop" stops working.
- **"stop" is handled on both paths.** Alexa may route it to
  `AMAZON.StopIntent`, or the catch-all may swallow it into the slot. The
  service ends the session either way: by intent name, and by exact phrase
  match against the spoken text. A carrier phrase is stripped before that
  comparison, so "tell me stop" also ends the session.
