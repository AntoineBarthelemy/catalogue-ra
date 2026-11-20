// Petit serveur (Cloudflare Worker) pour « Voir avec ma photo » par IA, méthode hybride
// (décision catalogue-ra-photo-ia-1911 du 19/11/2026 : hybride + OpenAI ; « on veut du naturel »).
// Version 3 du 20/11/2026 : la page envoie l'image déjà composée (photo du client + notre modèle 3D posé aux vraies cotes)
// en fichier, et le serveur la transmet telle quelle à OpenAI, puis renvoie la réponse telle quelle : aucun décodage
// d'image ici, pour rester sous la limite de calcul gratuite de Cloudflare. Rien n'est gardé ici.
// Essais du 20/11 : sans masque, l'IA fond le meuble dans la photo de façon naturelle ; avec masque, elle repeint la zone.
// La page recolle ensuite seulement la zone du meuble sur la photo d'origine et contrôle que le meuble n'a pas changé.
// À coller tel quel par Antoine dans Cloudflare (Workers, « Edit code »). Secret : CLE_IA (clé du projet OpenAI
// « catalogue-ra »). Variables : ORIGINE = https://antoinebarthelemy.dev ; MODELE = gpt-image-2.6-sunburst
// (gpt-image-1 retiré par OpenAI le 23/10/2026 ; relire developers.openai.com/api/docs/deprecations avant de changer).

const CONSIGNE = [
  "This is a real photo of a room. A 3D piece of furniture has been composited into it.",
  "Make the composite look like a natural, real photograph: match the room's lighting direction, light colour,",
  "contact shadows on the floor and reflections on the furniture.",
  "Do NOT change the furniture's shape, proportions, position, size, materials, texture pattern or colours.",
  "Do NOT change anything else in the photo: walls, floor, objects and framing stay exactly the same, no stretching, no cropping.",
].join(" ");

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": env.ORIGINE, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST" || req.headers.get("Origin") !== env.ORIGINE) return new Response("interdit", { status: 403 });
    const entree = await req.formData();
    const image = entree.get("image");
    if (!image || typeof image === "string" || image.size > 12_000_000) return new Response(JSON.stringify({ error: { message: "image absente ou trop lourde" } }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const appel = (fidelite) => {
      const f = new FormData();
      f.append("model", env.MODELE || "gpt-image-2.6-sunburst");
      f.append("prompt", CONSIGNE);
      f.append("image", image, "piece.png");
      f.append("size", String(entree.get("taille") || "auto"));
      f.append("quality", "medium");
      f.append("output_format", "jpeg");
      if (fidelite) f.append("input_fidelity", "high");
      return fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer " + env.CLE_IA }, body: f });
    };
    let r = await appel(true);
    // Si le réglage de fidélité élevée est refusé par le modèle, on réessaie une fois sans lui.
    if (r.status === 400) { const t = await r.clone().text(); if (/input_fidelity/i.test(t)) r = await appel(false); }
    // Réponse d'OpenAI renvoyée telle quelle (image en base64 dans data[0].b64_json, ou message d'erreur).
    return new Response(r.body, { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  },
};
