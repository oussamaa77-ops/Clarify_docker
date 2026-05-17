import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { emailFactureClient, emailFactureRejetee } from "./email.templates";
import { validerXmlUBL } from "./dgi_validator";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  return createClient(url, key);
}

const ligneSchema = z.object({
  designation: z.string().min(1),
  quantite: z.number().positive(),
  prix_unitaire: z.number().nonnegative(),
  taux_tva: z.number().min(0).max(100).default(20),
});

async function envoyerEmail(to: string, subject: string, html: string): Promise<boolean> {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL ?? "onboarding@resend.dev";
  if (!resendKey) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `HisabPro <${fromEmail}>`, to: [to], subject, html }),
    });
    return res.ok;
  } catch { return false; }
}

// ─── Appel Groq uniquement (Gemini bloqué depuis Codespaces) ────────────────
async function callAI(prompt: string, imageBase64?: string, mimeType?: string): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error("GROQ_API_KEY manquante");

  const model = imageBase64
    ? "meta-llama/llama-4-scout-17b-16e-instruct"
    : "llama-3.3-70b-versatile";

  const userContent: any = imageBase64
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType ?? "image/jpeg"};base64,${imageBase64}` } },
      ]
    : prompt;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0,
      messages: [{ role: "user", content: userContent }],
      ...(imageBase64 ? {} : { response_format: { type: "json_object" } }),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err.slice(0, 150)}`);
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? "{}";
  console.log("[OCR Groq] model:", model, "| chars:", content.length);
  return content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
}

export const generateFactureXml = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ facture_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { data: facture, error: fErr } = await supabase
      .from("factures")
      .select("*, clients(nom,ice,if_fiscal,adresse,email), dossiers(nom_societe,ice,if_fiscal,adresse)")
      .eq("id", data.facture_id).single();
    if (fErr || !facture) throw new Error("Facture introuvable");

    const lignes = ((facture.lignes ?? []) as unknown[]).map((l) => ligneSchema.parse(l));
    const societe = (facture as any).dossiers;
    const client  = (facture as any).clients;
    const esc = (s: string | null | undefined) =>
      (s ?? "").replace(/[<>&'"]/g, (c: string) =>
        (({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }) as Record<string, string>)[c]);

    const lignesXml = lignes.map((l, i) => {
      const ht = l.quantite * l.prix_unitaire;
      const tva = ht * (l.taux_tva / 100);
      return `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${l.quantite}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="MAD">${ht.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal><cbc:TaxAmount currencyID="MAD">${tva.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="MAD">${ht.toFixed(2)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="MAD">${tva.toFixed(2)}</cbc:TaxAmount>
        <cac:TaxCategory><cbc:Percent>${l.taux_tva}</cbc:Percent><cac:TaxScheme><cbc:ID>TVA</cbc:ID></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>${esc(l.designation)}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="MAD">${l.prix_unitaire.toFixed(2)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`;
    }).join("\n");

    if (facture.date_echeance && facture.date_echeance <= facture.date_facture) {
      const d = new Date(facture.date_facture);
      d.setDate(d.getDate() + 30);
      (facture as any).date_echeance = d.toISOString().slice(0, 10);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:dgi="urn:dgi-ma:2026:1.0">
  <cbc:CustomizationID>DGI-MA:2026:1.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:dgi.gov.ma:2026:einvoice</cbc:ProfileID>
  <cbc:ID>${esc(facture.numero ?? facture.id)}</cbc:ID>
  <cbc:IssueDate>${facture.date_facture}</cbc:IssueDate>
  ${facture.date_echeance ? `<cbc:DueDate>${facture.date_echeance}</cbc:DueDate>` : ""}
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>MAD</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>${esc(societe?.nom_societe)}</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>${esc(societe?.adresse)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>MA</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>${esc(societe?.ice)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>ICE</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyName><cbc:Name>${esc(client?.nom)}</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>${esc(client?.ice)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>ICE</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="MAD">${Number(facture.montant_tva).toFixed(2)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="MAD">${Number(facture.montant_ht).toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="MAD">${Number(facture.montant_ht).toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="MAD">${Number(facture.montant_ttc).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="MAD">${Number(facture.montant_ttc).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lignesXml}
</Invoice>`;

    const hash = createHash("sha256").update(xml).digest("hex");
    await supabase.from("factures").update({ xml_ubl: xml, hash_sha256: hash, statut: "envoyee", statut_dgi: "en_analyse" }).eq("id", data.facture_id);

    const validation = await validerXmlUBL(xml);
    const { conforme, erreurs, avertissements, source } = validation;
    const dgi_uuid = conforme ? `DGI-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,8).toUpperCase()}` : null;
    const dgi_response = { source, conforme, timestamp: new Date().toISOString(), uuid: dgi_uuid, message: conforme ? "Facture validée" : "Facture rejetée", erreurs, avertissements };

    await supabase.from("factures").update({ dgi_uuid, dgi_response, statut: conforme ? "conforme" : "rejetee", statut_dgi: conforme ? "conforme" : "rejetee" }).eq("id", data.facture_id);

    if (conforme && Number(facture.montant_ttc) > 0) {
      const ref = facture.numero ?? facture.id;
      const typeFacture = (facture as any).type_facture ?? "standard";
      if (typeFacture === "acompte") {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Acompte ${ref}`,     debit: Number(facture.montant_ttc), credit: 0, reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "4191",  date_ecriture: facture.date_facture, libelle: `Avance reçue ${ref}`, debit: 0, credit: Number(facture.montant_ht), reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA acompte ${ref}`,  debit: 0, credit: Number(facture.montant_tva), reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      } else if (typeFacture === "solde") {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Solde ${ref}`, debit: Number(facture.montant_ttc), credit: 0, reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Vente ${ref}`, debit: 0, credit: Number(facture.montant_ht), reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA ${ref}`, debit: 0, credit: Number(facture.montant_tva), reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "OD",  compte_numero: "4191",  date_ecriture: facture.date_facture, libelle: `Imputation acompte ${ref}`, debit: Number(facture.montant_ht), credit: 0, reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "OD",  compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Imputation acompte ${ref}`, debit: 0, credit: Number(facture.montant_ht), reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      } else {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Vente ${ref}`, debit: Number(facture.montant_ttc), credit: 0, reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Vente ${ref}`, debit: 0, credit: Number(facture.montant_ht), reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA collectée ${ref}`, debit: 0, credit: Number(facture.montant_tva), reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      }
      await supabase.from("ged_documents").insert({ dossier_id: facture.dossier_id, facture_id: facture.id, nom_fichier: `${facture.numero ?? facture.id}.xml`, type_document: "facture_client", hash_sha256: hash, dgi_uuid, horodatage: new Date().toISOString(), taille_bytes: xml.length, mime_type: "application/xml" });
      if (client?.email) {
        const { subject, html } = emailFactureClient({ clientNom: client.nom, numeroFacture: facture.numero ?? facture.id, montantTTC: Number(facture.montant_ttc), dateEcheance: facture.date_echeance, dgiUuid: dgi_uuid ?? "", hashSha256: hash, societeNom: societe?.nom_societe ?? "HisabPro" });
        await envoyerEmail(client.email, subject, html);
      }
    } else if (!conforme) {
      const { data: prof } = await supabase.from("profiles").select("email").limit(1).maybeSingle();
      if (prof?.email) {
        const { subject, html } = emailFactureRejetee({ comptableEmail: prof.email, numeroFacture: facture.numero ?? facture.id, clientNom: client?.nom ?? "Client", erreurs, dgiResponse: dgi_response });
        await envoyerEmail(prof.email, subject, html);
      }
    }
    await supabase.from("audit_logs").insert({ dossier_id: facture.dossier_id, action: conforme ? "efacture_conforme" : "efacture_rejetee", ressource_type: "facture", ressource_id: facture.id, details: { dgi_uuid, hash: hash.slice(0,16) } });
    return { success: true, conforme, xml, hash, dgi_uuid, dgi_response, email_sent: conforme && !!client?.email, client_email_manquant: conforme && !client?.email };
  });

// ─── ocrFacture ───────────────────────────────────────────────────────────────
// Gemini (si disponible) → fallback Groq. Zéro regex sur les montants.
export const ocrFacture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    extracted_text: z.string().default(""),
    image_base64: z.string().optional(),
    mime_type: z.string().default("image/jpeg"),
    dossier_id: z.string().uuid(),
  }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { data: dossier } = await supabase.from("dossiers" as any).select("nom_societe,ice").eq("id", data.dossier_id).maybeSingle();
    const dossierNom = (dossier as any)?.nom_societe ?? "";
    const dossierIce = (dossier as any)?.ice ?? "";
    const text = data.extracted_text ?? "";

    let result: any = {
      client_nom_extrait: "", ice_client: null, numero_facture: null,
      date_facture: null, date_echeance: null, delai_paiement_jours: 30,
      montant_ht: 0, montant_tva: 0, montant_ttc: 0, lignes: [],
      type_facture: "standard", numero_commande: null, numero_acompte: null,
      montant_commande_total_ht: null, montant_commande_total_ttc: null,
      montant_restant_du: null, sens_facture: "inconnu",
      emetteur_nom: null, emetteur_ice: null,
    };
    let confidence: "high" | "medium" | "low" = "low";
    let method = "regex";

    const prompt = `Tu es expert-comptable et analyste de documents financiers marocains. Extrais les données de cette facture avec précision maximale. Réponds UNIQUEMENT avec un JSON valide, sans texte avant ou après.

CONTEXTE DOSSIER:
La société dont on gère la comptabilité est : "${dossierNom}" (ICE: "${dossierIce || "non renseigné"}")

RÈGLE 1 — IDENTIFIER LES PARTIES:
- ÉMETTEUR (vendeur) = société avec RC/CNSS/IF/ICE dans ses coordonnées ou en-tête. C'est lui qui réclame le paiement.
- CLIENT (acheteur) = nom précédé de "Client:", "Facturer à:", "Bill to:", "Destinataire:", "Adressé à:", bloc encadré CLIENT. C'est lui qui paie.
- Ne JAMAIS mettre l'émetteur dans client_nom.

RÈGLE 2 — SENS DE LA FACTURE:
Compare les noms/ICE avec la société "${dossierNom}" (ICE: "${dossierIce}"):
- Si "${dossierNom}" est l'ÉMETTEUR → sens_facture = "client" (facture de vente émise par notre société)
- Si "${dossierNom}" est le CLIENT → sens_facture = "fournisseur" (facture d'achat reçue d'un fournisseur)
- Sinon → sens_facture = "inconnu"

RÈGLE 3 — TYPE DE FACTURE:
- "acompte" : contient les mots acompte, avance, versement, arrhes, reliquat, solde restant dû
- "solde"   : facture finale après acomptes
- "avoir"   : avoir, note de crédit, remboursement
- "standard": facture normale

RÈGLE 4 — MONTANTS (ACOMPTE):
- montant_ttc = montant de CETTE facture seulement (pas le total commande)
- montant_restant_du = reliquat à payer après cet acompte
- montant_commande_total_ttc = total de toute la commande

RÈGLE 5 — DATES: Convertir DD/MM/YYYY ou DD/MM/YY en YYYY-MM-DD.

RÈGLE 6 — ICE: exactement 15 chiffres consécutifs.

Réponds UNIQUEMENT avec ce JSON valide sans markdown:
{
  "sens_facture": "client|fournisseur|inconnu",
  "emetteur_nom": "string",
  "emetteur_ice": "string|null",
  "client_nom": "string",
  "client_ice": "string|null",
  "client_adresse": "string|null",
  "numero": "string|null",
  "date": "YYYY-MM-DD|null",
  "date_echeance": "YYYY-MM-DD|null",
  "type_facture": "standard|acompte|solde|avoir",
  "numero_commande": "string|null",
  "numero_acompte": null,
  "montant_ht": 0,
  "montant_tva": 0,
  "taux_tva": 20,
  "montant_ttc": 0,
  "montant_commande_total_ht": null,
  "montant_commande_total_ttc": null,
  "montant_restant_du": null,
  "description": "string",
  "lignes": [{"description":"string","quantite":1,"prix_unitaire_ht":0,"total_ht":0,"taux_tva":20}]
}${text ? `\n\nTexte extrait de la facture:\n${text.slice(0, 3000)}` : ""}`;

    try {
      const aiResponse = await callAI(prompt, data.image_base64, data.mime_type);
      const ai = JSON.parse(aiResponse);

      result = {
        ...result,
        sens_facture:               ai.sens_facture              ?? "inconnu",
        emetteur_nom:               ai.emetteur_nom              ?? null,
        emetteur_ice:               ai.emetteur_ice              ?? null,
        client_nom_extrait:         ai.client_nom                ?? "",
        ice_client:                 ai.client_ice                ?? null,
        numero_facture:             ai.numero                    ?? null,
        date_facture:               ai.date                      ?? null,
        date_echeance:              ai.date_echeance             ?? null,
        montant_ht:                 Number(ai.montant_ht)        || 0,
        montant_tva:                Number(ai.montant_tva)       || 0,
        montant_ttc:                Number(ai.montant_ttc)       || 0,
        type_facture:               ai.type_facture              ?? "standard",
        numero_commande:            ai.numero_commande           ?? null,
        numero_acompte:             ai.numero_acompte            ?? null,
        montant_commande_total_ht:  Number(ai.montant_commande_total_ht)  || null,
        montant_commande_total_ttc: Number(ai.montant_commande_total_ttc) || null,
        montant_restant_du:         Number(ai.montant_restant_du)         || null,
        lignes: (ai.lignes ?? []).map((l: any) => ({
          designation:   l.description ?? l.designation ?? "Prestation",
          quantite:      Number(l.quantite)                             || 1,
          prix_unitaire: Number(l.prix_unitaire_ht ?? l.prix_unitaire) || 0,
          taux_tva:      Number(l.taux_tva)                            || 20,
        })),
      };
      confidence = "high";
      method = "ai";
      if (!result.date_echeance && result.date_facture) {
        const d = new Date(result.date_facture);
        d.setDate(d.getDate() + 30);
        result.date_echeance = d.toISOString().slice(0, 10);
      }
    } catch (e) {
      console.log("[OCR] IA échouée:", String(e));
    }

    if (!result.lignes?.length && result.montant_ttc > 0) {
      result.lignes = [{ designation: "Prestation (à préciser)", quantite: 1, prix_unitaire: result.montant_ht, taux_tva: 20 }];
    }

    // Résolution client en base
    let client_id: string | null = null;
    let client_action: "found" | "created" | "not_found" = "not_found";
    let client_trouve: any = null;
    const nomClient = result.client_nom_extrait?.trim();
    const iceClient = result.ice_client?.trim();

    if ((nomClient || iceClient) && result.sens_facture !== "fournisseur") {
      if (iceClient) {
        const { data: byIce } = await supabase.from("clients").select("*").eq("dossier_id", data.dossier_id).eq("ice", iceClient).is("deleted_at", null).maybeSingle();
        if (byIce) { client_id = byIce.id; client_action = "found"; client_trouve = byIce; }
      }
      if (!client_id && nomClient) {
        const { data: byNom } = await supabase.from("clients").select("*").eq("dossier_id", data.dossier_id).ilike("nom", `%${nomClient.slice(0,20)}%`).is("deleted_at", null).maybeSingle();
        if (byNom) { client_id = byNom.id; client_action = "found"; client_trouve = byNom; }
      }
      if (!client_id && result.sens_facture === "client" && nomClient) {
        const { data: nouveau } = await supabase.from("clients").insert({ dossier_id: data.dossier_id, nom: nomClient, ice: iceClient ?? null }).select().single();
        if (nouveau) { client_id = nouveau.id; client_action = "created"; client_trouve = nouveau; }
      }
    }

    console.log("[OCR] final:", { confidence, method, sens: result.sens_facture, client: result.client_nom_extrait, ttc: result.montant_ttc });
    return { result: { ...result, confidence, method, client_id, client_action, client_trouve } };
  });

export const marquerPayee = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ facture_id: z.string().uuid(), date_paiement: z.string(), mode: z.string().default("virement") }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { data: f } = await supabase.from("factures").select("dossier_id,montant_ttc,numero,statut").eq("id", data.facture_id).single();
    if (!f) throw new Error("Facture introuvable");
    await supabase.from("factures").update({ statut_paiement: "payee", date_paiement: data.date_paiement }).eq("id", data.facture_id);
    const ref = f.numero ?? data.facture_id;
    await supabase.from("ecritures_comptables").insert([
      { dossier_id: f.dossier_id, journal_code: "BQ", compte_numero: "5141", date_ecriture: data.date_paiement, libelle: `Encaissement ${ref}`, debit: Number(f.montant_ttc), credit: 0, reference_piece: ref, facture_id: data.facture_id, valide: true },
      { dossier_id: f.dossier_id, journal_code: "BQ", compte_numero: "3421", date_ecriture: data.date_paiement, libelle: `Règlement client ${ref}`, debit: 0, credit: Number(f.montant_ttc), reference_piece: ref, facture_id: data.facture_id, valide: true },
    ]);
    return { ok: true };
  });

export const ajouterEmailClient = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ client_id: z.string().uuid(), email: z.string().email() }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { error } = await supabase.from("clients").update({ email: data.email }).eq("id", data.client_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ─── analyserTransactions (pour relevé bancaire) ──────────────────────────────
export const analyserTransactions = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    dossier_id: z.string().uuid(),
    dossier_nom: z.string().default(""),
    dossier_ice: z.string().default(""),
    transactions_brutes: z.array(z.any()),
    factures_client: z.array(z.any()),
    factures_fourn: z.array(z.any()),
    fournisseurs: z.array(z.any()),
    clients: z.array(z.any()),
    remarques: z.string().optional(),
  }).parse(input))
  .handler(async ({ data }) => {
    const prompt = `Tu es expert-comptable marocain certifié (PCM/CGNC). Analyse ces transactions bancaires.

SOCIÉTÉ: "${data.dossier_nom}" (ICE: ${data.dossier_ice || "non renseigné"})
CRÉDITS = encaissements clients. DÉBITS = paiements fournisseurs ou charges.

FACTURES CLIENTS NON ENCAISSÉES:
${JSON.stringify(data.factures_client.map((f: any) => ({ id: f.id, num: f.numero, client: f.clients?.nom, ttc: Number(f.montant_ttc), echeance: f.date_echeance })))}

FACTURES FOURNISSEURS NON PAYÉES:
${JSON.stringify(data.factures_fourn.map((f: any) => ({ id: f.id, num: f.numero, fournisseur: f.fournisseur_nom, ttc: Number(f.montant_ttc), echeance: f.date_echeance })))}

CLIENTS: ${JSON.stringify(data.clients.map((c: any) => ({ nom: c.nom, ice: c.ice })))}
FOURNISSEURS: ${JSON.stringify(data.fournisseurs.map((f: any) => ({ nom: f.nom, ice: f.ice })))}
${data.remarques ? `REMARQUES (PRIORITÉ ABSOLUE):\n${data.remarques}\n` : ""}

TRANSACTIONS:
${JSON.stringify(data.transactions_brutes.map((tx: any) => ({ ligne: tx.ligne, date: tx.date_operation, libelle: tx.nature_operation, debit: tx.montant_debit, credit: tx.montant_credit })))}

ALGORITHME (ordre strict):
1. REMARQUES → 100%
2. NUMÉRO FACTURE dans libellé → 95%, retourner facture_id UUID
3. NOM TIERS dans libellé (3+ lettres communes) → 85%, retourner facture_id si montant compatible
4. MONTANT TTC EXACT ±1 MAD + date ≤ echeance+15j → 80%, retourner facture_id
5. MOTS-CLÉS PCM:
   CNSS|AMO→6174(0%) | TVA|DGI|IR|IS→4456(0%) | SALAIRE→6171(0%)
   IAM|INWI|ORANGE|TELECOM→6132(20%) | LOYER|LOCATION→6131(20%)
   GASOIL|CARBURANT→6122(20%) | EAU|ONEE|AMENAU→6125(7%)
   ASSURANCE→6161(0%) | FRAIS BANCAIRES|COMMISSION→6347(10%)
   RETRAIT|GAB|ESPECES→5161(0%) | IMPORT|DOUANE→6146(0%)
   RESTAURANT|LOUNG|CAFE|REPRESENTATION→6147(0%)
   ENTRETIEN|REPARATION→6141(20%) | TRANSPORT|DEPLACEMENT→6145(0%)
   → 75%
6. DIRECTION: credit→encaissement_client/3421, debit→paiement_fournisseur/4411 → 60%
7. INCONNU → necessite_remarque=true

Réponds UNIQUEMENT avec ce JSON:
{"analyses":[{"ligne":0,"nature_principale":"encaissement_client|paiement_fournisseur|salaires|cnss_amo|tva_dgi|loyers|eau_electricite|telecom|gasoil|assurance|entretien|frais_bancaires|frais_representation|frais_douane|retrait_especes|interets_crediteurs|virement_interne|autre","code_pcm":"string","tiers_nom":"string|null","facture_num":"string|null","facture_id":"string|null","montant_ht":0,"montant_tva":0,"taux_tva":0,"confiance":0,"etape_rapprochement":"remarques|numero_facture|nom_tiers|montant_date|mots_cles|direction|inconnu","alerte":"string|null","necessite_remarque":false,"message_pour_comptable":"string|null","suggestions":[]}]}`;

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) throw new Error("GROQ_API_KEY manquante");

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0, max_tokens: 4000, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
    });
    if (!res.ok) { const err = await res.json() as any; throw new Error(`Groq: ${err.error?.message ?? "erreur"}`); }
    const groqData = await res.json() as any;
    let content = groqData.choices[0].message.content;
    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(content) as { analyses: any[] };
  });



