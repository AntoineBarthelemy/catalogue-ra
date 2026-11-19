// Petit serveur (Cloudflare Worker) pour « Voir avec ma photo » par IA, méthode hybride
// (décision catalogue-ra-photo-ia-1911 du 19/11/2026 : hybride + OpenAI ; « on veut du naturel »).
// La page envoie l'image déjà composée par le navigateur (photo du client + notre modèle 3D posé aux vraies cotes)
// et un masque PNG : transparent = zone que l'IA peut retoucher (le meuble et son ombre), opaque = reste de la photo, intact.
// L'IA ne fait que fondre le meuble dans la photo : lumière, ombres, reflets. Rien n'est gardé ici.
// À coller tel quel par Antoine dans Cloudflare (Workers, « Edit code »). Secret à créer par lui : CLE_IA (clé OpenAI du
// projet OpenAI dédié « catalogue-ra »). Variables : ORIGINE = https://antoinebarthelemy.dev ; MODELE = gpt-image-1
// (ou plus récent : le chef relit la doc OpenAI au branchement).

const CONSIGNE = [
  "This is a real photo of a room. A 3D piece of furniture has been composited into it.",
  "Make the composite look like a natural, real photograph: match the room's lighting direction, light colour,",
  "contact shadows on the floor and reflections on the furniture.",
  "Do NOT change the furniture's shape, proportions, materials, texture pattern or colours.",
  "Do NOT change anything outside the editable area: walls, floor, objects and framing stay exactly the same, no stretching, no cropping.",
].join(" ");

const b64EnOctets = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": env.ORIGINE, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST" || req.headers.get("Origin") !== env.ORIGINE) return new Response("interdit", { status: 403 });
    const { image, masque, taille } = await req.json(); // PNG base64 sans en-tête data:, même taille pour les deux
    if (!image || image.length > 12_000_000) return new Response("image absente ou trop lourde", { status: 400, headers: cors });
    const f = new FormData();
    f.append("model", env.MODELE || "gpt-image-1");
    f.append("prompt", CONSIGNE);
    f.append("image", new Blob([b64EnOctets(image)], { type: "image/png" }), "piece.png");
    if (masque) f.append("mask", new Blob([b64EnOctets(masque)], { type: "image/png" }), "masque.png");
    f.append("size", taille || "auto");
    f.append("quality", "medium");
    f.append("input_fidelity", "high");
    const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer " + env.CLE_IA }, body: f });
    if (!r.ok) return new Response("erreur du service d'IA " + r.status, { status: 502, headers: cors });
    const j = await r.json();
    const sortie = j.data?.[0]?.b64_json;
    if (!sortie) return new Response("aucune image rendue", { status: 502, headers: cors });
    return new Response(JSON.stringify({ image: sortie }), { headers: { ...cors, "Content-Type": "application/json" } });
  },
};
