// Petit serveur (Cloudflare Worker) pour « Voir avec ma photo (IA) ».
// Version 4 du 21/11/2026 (directive d'Antoine 2026-11-21-catalogue-ra-photo-ia-clarif) : le client n'a RIEN à placer.
// La page envoie sa photo (« image ») et une ou deux images du produit vues sous plusieurs angles (« ref »), avec le nom,
// la catégorie et les cotes ; l'IA incorpore le produit dans la photo, à l'échelle, à un endroit naturel.
// Les champs texte sont nettoyés et bornés ici : la consigne est écrite par le serveur, jamais par la page.
// Sans « ref », le serveur garde le comportement de la version 3 (image déjà composée, l'IA ne fond que lumière et ombres).
// Aucun décodage d'image ici (limite de calcul gratuite de Cloudflare) ; rien n'est gardé ici.
// À coller tel quel par Antoine dans Cloudflare (Workers, « Edit code »). Secret : CLE_IA (clé du projet OpenAI
// « catalogue-ra »). Variables : ORIGINE = https://antoinebarthelemy.dev ; MODELE = gpt-image-2.6-sunburst
// (gpt-image-1 retiré par OpenAI le 23/10/2026 ; relire developers.openai.com/api/docs/deprecations avant de changer).

const CONSIGNE_V3 = [
  "This is a real photo of a room. A 3D piece of furniture has been composited into it.",
  "Make the composite look like a natural, real photograph: match the room's lighting direction, light colour,",
  "contact shadows on the floor and reflections on the furniture.",
  "Do NOT change the furniture's shape, proportions, position, size, materials, texture pattern or colours.",
  "Do NOT change anything else in the photo: walls, floor, objects and framing stay exactly the same, no stretching, no cropping.",
].join(" ");

const propre = (v, max) => String(v ?? "").replace(/[^\p{L}\p{N} ,.'()\/-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
const cote = (v) => { const n = Math.round(Number(v)); return n > 0 && n < 2000 ? n : null; };

function consigneDirecte(e, nbRefs) {
  const nom = propre(e.get("nom"), 90) || "the product";
  const cat = propre(e.get("categorie"), 40);
  const l = cote(e.get("l")), p = cote(e.get("p")), h = cote(e.get("h"));
  const dims = l && p && h ? `Its real size is ${l} cm wide, ${p} cm deep and ${h} cm high: render it at exactly this real-world scale relative to the room (door frames, chairs, tables, floor boards and walls give the scale).` : "Render it at a realistic real-world scale.";
  return [
    `Image 1 is a real photo of a customer's home. Image${nbRefs > 1 ? "s 2 to " + (nbRefs + 1) : " 2"} show${nbRefs > 1 ? "" : "s"} one product sold by a shop: "${nom}"${cat ? " (" + cat + ")" : ""}, seen on a plain background.`,
    "Edit image 1 to show this exact product placed in the room, where such a product would naturally go (on the floor, against a wall, on a table or shelf, or hanging, depending on the product), in free space, without hiding or replacing an existing piece of furniture.",
    dims,
    "The product must be identical to the reference images: same shape, proportions, materials, texture pattern and colours. Do not redesign, simplify or restyle it.",
    "Match the room's perspective, lighting direction and colour, with natural contact shadows and reflections, so the result looks like a real, unedited photograph.",
    "Keep everything else in image 1 exactly as it is: same framing, same walls, floor, objects and colours; no cropping, no stretching, no added objects other than the product.",
  ].join(" ");
}

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": env.ORIGINE, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" };
    const erreur = (m) => new Response(JSON.stringify({ error: { message: m } }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST" || req.headers.get("Origin") !== env.ORIGINE) return new Response("interdit", { status: 403 });
    const entree = await req.formData();
    const image = entree.get("image");
    if (!image || typeof image === "string" || image.size > 12_000_000) return erreur("image absente ou trop lourde");
    const refs = entree.getAll("ref").filter((r) => r && typeof r !== "string" && r.size <= 6_000_000).slice(0, 2);
    const taille = /^(\d{3,4})x(\d{3,4})$/.test(String(entree.get("taille"))) ? String(entree.get("taille")) : "auto";
    const appel = (fidelite) => {
      const f = new FormData();
      f.append("model", env.MODELE || "gpt-image-2.6-sunburst");
      if (refs.length) {
        f.append("prompt", consigneDirecte(entree, refs.length));
        f.append("image[]", image, "piece.png");
        refs.forEach((r, i) => f.append("image[]", r, "produit-" + (i + 1) + ".png"));
      } else {
        f.append("prompt", CONSIGNE_V3);
        f.append("image", image, "piece.png");
      }
      f.append("size", taille);
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
