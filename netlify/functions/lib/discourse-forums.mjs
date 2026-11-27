// netlify/functions/lib/discourse-forums.mjs — the Discourse forums Stage 3
// is allowed to search.
//
// EDIT THIS LIST to add or remove forums. The audience-map step can only
// choose from these hosts; anything else it proposes is ignored, so the
// function never calls an arbitrary URL the model made up. Each entry must
// be a public Discourse forum whose /search.json endpoint works without
// logging in (open https://<host>/search.json?q=test in a browser to check).
//
// `about` is shown to the model so it knows when a forum is relevant.

export const DISCOURSE_FORUMS = [
  { host: "discuss.huggingface.co", about: "Hugging Face: machine learning models, datasets, training and deployment" },
  { host: "community.hivemq.com", about: "HiveMQ: MQTT brokers, IoT messaging and device connectivity" },
];
