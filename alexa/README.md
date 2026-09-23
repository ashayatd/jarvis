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

## Deploying it

1. Alexa Developer Console → your skill → **Build** → **Interaction Model** →
   **JSON Editor**.
2. Replace the whole document with `interaction-model.json`.
3. Check `invocationName` matches the invocation name the skill already has.
   This file assumes **"ai mode"**; if yours differs, change it here rather
   than in the console, so the two stay in step.
4. **Save Model**, then **Build Model**. Wait for the build to finish.
5. Endpoint is unchanged — it still points at the tunnel to this service.

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
