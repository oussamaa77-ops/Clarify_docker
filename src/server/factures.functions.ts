import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { emailFactureClient, emailFactureRejetee } from "./email.templates";
import { validerXmlUBL } from "./dgi_validator";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.SUPABASE_PUBLISHABLE_KEY
    ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  return createClient(url, key);
}

const ligneSchema = z.object({
  designation: z.string().min(1),
  quantite: z.number().positive(),
  prix_unitaire: z.number().nonnegative(),
  taux_tva: z.number().min(0).max(100).default(20),
});

// ─── Envoi email via Resend ───────────────────────────────────────────────────
async function envoyerEmail(to: string, subject: string, html: string): Promise<boolean> {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL ?? "onboarding@resend.dev";
  if (!resendKey) { console.log("[EMAIL] RESEND_API_KEY manquante"); return false; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `HisabPro <${fromEmail}>`, to: [to], subject, html }),
    });
    const result = await res.json();
    console.log("[EMAIL] Resend response:", res.status, JSON.stringify(result));
    return res.ok;
  } catch (e) { console.log("[EMAIL] Erreur:", String(e)); return false; }
}

// ─── generateFactureXml ───────────────────────────────────────────────────────
export const generateFactureXml = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ facture_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();

    const { data: facture, error: fErr } = await supabase
      .from("factures")
      .select("*, clients(nom,ice,if_fiscal,adresse,email), dossiers(nom_societe,ice,if_fiscal,adresse)")
      .eq("id", data.facture_id)
      .single();
    if (fErr || !facture) throw new Error("Facture introuvable");

    const lignes = ((facture.lignes ?? []) as unknown[]).map((l) => ligneSchema.parse(l));
    const societe = (facture as any).dossiers;
    const client  = (facture as any).clients;

    const esc = (s: string | null | undefined) =>
      (s ?? "").replace(/[<>&'"]/g, (c: string) =>
        (({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }) as Record<string, string>)[c]);

    const lignesXml = lignes.map((l, i) => {
      const ht  = l.quantite * l.prix_unitaire;
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

    await supabase.from("factures").update({
      xml_ubl: xml, hash_sha256: hash, statut: "envoyee", statut_dgi: "en_analyse",
    }).eq("id", data.facture_id);

    const validation = await validerXmlUBL(xml);
    const { conforme, erreurs, avertissements, source } = validation;

    const dgi_uuid = conforme
      ? `DGI-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
      : null;

    const dgi_response = {
      source, conforme, timestamp: new Date().toISOString(), uuid: dgi_uuid,
      message: conforme
        ? source === "peppol"
          ? "Facture validée par le validateur PEPPOL UBL 2.1 (conforme DGI-MA)"
          : "Facture validée localement — structure UBL 2.1 conforme"
        : "Facture rejetée — erreurs de conformité UBL détectées",
      erreurs, avertissements,
    };

    await supabase.from("factures").update({
      dgi_uuid, dgi_response,
      statut: conforme ? "conforme" : "rejetee",
      statut_dgi: conforme ? "conforme" : "rejetee",
    }).eq("id", data.facture_id);

    if (conforme && Number(facture.montant_ttc) > 0) {
      const ref         = facture.numero ?? facture.id;
      const typeFacture = (facture as any).type_facture ?? "standard";

      if (typeFacture === "acompte") {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Acompte ${ref}`,          debit: Number(facture.montant_ttc), credit: 0,                     reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "4191",  date_ecriture: facture.date_facture, libelle: `Avance reçue ${ref}`,      debit: 0, credit: Number(facture.montant_ht),                      reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA acompte ${ref}`,       debit: 0, credit: Number(facture.montant_tva),                     reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      } else if (typeFacture === "solde") {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Solde ${ref}`,             debit: Number(facture.montant_ttc), credit: 0,                     reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Vente solde ${ref}`,        debit: 0, credit: Number(facture.montant_ht),                      reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA solde ${ref}`,          debit: 0, credit: Number(facture.montant_tva),                     reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "OD",  compte_numero: "4191",  date_ecriture: facture.date_facture, libelle: `Imputation acompte ${ref}`, debit: Number(facture.montant_ht), credit: 0,                      reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "OD",  compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Imputation acompte ${ref}`, debit: 0, credit: Number(facture.montant_ht),                      reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      } else {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Vente ${ref}`,             debit: Number(facture.montant_ttc), credit: 0,                     reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Vente ${ref}`,             debit: 0, credit: Number(facture.montant_ht),                      reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA collectée ${ref}`,     debit: 0, credit: Number(facture.montant_tva),                     reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      }

      await supabase.from("ged_documents").insert({
        dossier_id: facture.dossier_id, facture_id: facture.id,
        nom_fichier: `${facture.numero ?? facture.id}.xml`, type_document: "facture_client",
        hash_sha256: hash, dgi_uuid, horodatage: new Date().toISOString(),
        taille_bytes: xml.length, mime_type: "application/xml",
      });

      if (client?.email) {
        const { subject, html } = emailFactureClient({
          clientNom: client.nom, numeroFacture: facture.numero ?? facture.id,
          montantTTC: Number(facture.montant_ttc), dateEcheance: facture.date_echeance,
          dgiUuid: dgi_uuid ?? "", hashSha256: hash, societeNom: societe?.nom_societe ?? "HisabPro",
        });
        await envoyerEmail(client.email, subject, html);
      }
    } else if (!conforme) {
      const { data: prof } = await supabase.from("profiles").select("email").limit(1).maybeSingle();
      if (prof?.email) {
        const { subject, html } = emailFactureRejetee({
          comptableEmail: prof.email, numeroFacture: facture.numero ?? facture.id,
          clientNom: client?.nom ?? "Client", erreurs, dgiResponse: dgi_response,
        });
        await envoyerEmail(prof.email, subject, html);
      }
    }

    await supabase.from("audit_logs").insert({
      dossier_id: facture.dossier_id,
      action: conforme ? "efacture_conforme" : "efacture_rejetee",
      ressource_type: "facture", ressource_id: facture.id,
      details: { dgi_uuid, hash: hash.slice(0, 16), client_email: client?.email ?? null },
    });

    return {
      success: true, conforme, xml, hash, dgi_uuid, dgi_response,
      email_sent: conforme && !!client?.email,
      client_email_manquant: conforme && !client?.email,
    };
  });

// ─── marquerPayee ─────────────────────────────────────────────────────────────
export const marquerPayee = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    facture_id: z.string().uuid(),
    date_paiement: z.string(),
    mode: z.string().default("virement"),
  }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { data: f } = await supabase.from("factures").select("dossier_id,montant_ttc,numero,statut").eq("id", data.facture_id).single();
    if (!f) throw new Error("Facture introuvable");
    if (f.statut !== "conforme") throw new Error("Seules les factures conformes DGI peuvent être marquées payées");
    await supabase.from("factures").update({ statut_paiement: "payee", date_paiement: data.date_paiement }).eq("id", data.facture_id);
    const ref = f.numero ?? data.facture_id;
    await supabase.from("ecritures_comptables").insert([
      { dossier_id: f.dossier_id, journal_code: "BQ", compte_numero: "5141", date_ecriture: data.date_paiement, libelle: `Encaissement ${ref}`, debit: Number(f.montant_ttc), credit: 0, reference_piece: ref, facture_id: data.facture_id, valide: true },
      { dossier_id: f.dossier_id, journal_code: "BQ", compte_numero: "3421", date_ecriture: data.date_paiement, libelle: `Règlement client ${ref}`, debit: 0, credit: Number(f.montant_ttc), reference_piece: ref, facture_id: data.facture_id, valide: true },
    ]);
    await supabase.from("audit_logs").insert({
      dossier_id: f.dossier_id, action: "facture_payee",
      ressource_type: "facture", ressource_id: data.facture_id,
      details: { date_paiement: data.date_paiement, mode: data.mode },
    });
    return { ok: true };
  });

// ─── ajouterEmailClient ───────────────────────────────────────────────────────
export const ajouterEmailClient = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    client_id: z.string().uuid(),
    email: z.string().email(),
  }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { error } = await supabase.from("clients").update({ email: data.email }).eq("id", data.client_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ─── ocrFacture ──────────────────────────────────────────────────────────────
export const ocrFacture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    extracted_text: z.string().default(""),
    image_base64: z.string().optional(),
    mime_type: z.string().default("image/jpeg"),
    dossier_id: z.string().uuid(),
  }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const text = data.extracted_text ?? "";
    const norm = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ");

    let result: any = {
      client_nom_extrait: "", ice_client: null, if_fiscal_client: null, rc_client: null,
      numero_facture: null, date_facture: null, date_echeance: null,
      delai_paiement_jours: null, mode_reglement: null,
      montant_ht: 0, montant_tva: 0, montant_ttc: 0, lignes: [],
      type_facture: "standard",
      numero_commande: null, numero_acompte: null,
      montant_commande_total_ht: null, montant_commande_total_ttc: null,
      montant_restant_du: null,
    };
    let confidence: "high" | "medium" | "low" = "low";
    let method: "regex" | "ai" = "regex";

    const groqKey = process.env.GROQ_API_KEY;

    if (groqKey) {
      try {
        // ── PROMPT FINAL — générique, sans exemple spécifique ────────────────
        const prompt = `Tu es un expert-comptable et analyste de documents financiers. Tu dois extraire les données d'une facture avec une précision maximale.

RÈGLE FONDAMENTALE — IDENTIFIER LES PARTIES :
Une facture a TOUJOURS deux parties :
1. L'ÉMETTEUR (vendeur) = celui qui ÉMET la facture et demande le paiement
   → Identifié par : son en-tête, ses coordonnées fiscales (RC, IF, ICE, CNSS, TP), son logo
   → Peut être n'importe où (haut, bas, gauche, droite)
   → NE JAMAIS mettre l'émetteur dans client_nom

2. LE CLIENT (acheteur) = celui qui REÇOIT la facture et doit PAYER
   → Identifié UNIQUEMENT par les mots-clés : "Client :", "Facturer à :", "Bill to :",
     "Destinataire :", "Adressé à :", "À l'attention de :", "Envoyé à :", bloc "CLIENT"
   → Peut être n'importe où sur la facture
   → client_nom = UNIQUEMENT le nom du client, jamais l'émetteur

RÈGLE CRITIQUE : Ne JAMAIS confondre l'émetteur avec le client.
La présence des coordonnées fiscales (RC, IF, ICE, CNSS, TP) identifie l'émetteur, pas le client.

EXTRACTION ICE :
- Format ICE marocain : exactement 15 chiffres consécutifs
- L'ICE qui suit "Client :" ou "CE :" dans le bloc client = client_ice
- L'ICE dans l'en-tête ou pied de page de l'émetteur = emetteur_ice uniquement

DÉTECTION TYPE DE FACTURE :
- "acompte" → présence des mots : acompte, avance, versement, arrhes, provision, reliquat, solde restant dû
- "solde"   → facture finale après acomptes, solde de tout compte
- "avoir"   → avoir, note de crédit, remboursement, annulation
- "standard"→ facture normale sans ces mots

RÈGLES MONTANTS — FACTURE D'ACOMPTE :
La facture peut contenir PLUSIEURS montants :
- Montant COMMANDE TOTALE → montant_commande_total_ttc (ne pas mettre dans montant_ttc)
- Montant de CET ACOMPTE → montant_ttc (cherche "Total TTC" dans le récapitulatif)
- RELIQUAT restant → montant_restant_du (cherche "reliquat", "reste à payer", "solde restant")
→ montant_ttc = UNIQUEMENT le montant de cette facture, jamais le total commande

NORMALISATION LIGNES :
- Toujours retourner : description, quantite, prix_unitaire_ht, total_ht, taux_tva
- Si prix_unitaire_ht absent : calculer total_ht / quantite
- Taux TVA par défaut au Maroc : 20

Réponds UNIQUEMENT avec ce JSON valide, sans markdown, sans backticks :
{
  "client_nom": "nom exact du CLIENT qui paie (jamais l'émetteur)",
  "client_ice": "exactement 15 chiffres ou null",
  "client_adresse": "adresse du client ou null",
  "emetteur_nom": "nom de la société émettrice",
  "emetteur_ice": "ICE émetteur ou null",
  "numero": "numéro de facture ou null",
  "date": "YYYY-MM-DD ou null",
  "date_echeance": "YYYY-MM-DD ou null",
  "type_facture": "standard|acompte|solde|avoir",
  "numero_commande": "numéro BC/commande ou null",
  "numero_acompte": null,
  "montant_ht": 0,
  "montant_tva": 0,
  "taux_tva": 20,
  "montant_ttc": 0,
  "montant_commande_total_ht": null,
  "montant_commande_total_ttc": null,
  "montant_restant_du": null,
  "description": "description courte de la prestation",
  "lignes": [
    {
      "description": "désignation",
      "quantite": 1,
      "prix_unitaire_ht": 0.00,
      "total_ht": 0.00,
      "taux_tva": 20
    }
  ]
}`;

        const userContent: any[] = [];
        if (data.image_base64) {
          userContent.push({
            type: "image_url",
            image_url: { url: `data:${data.mime_type};base64,${data.image_base64}` },
          });
        }
        userContent.push({
          type: "text",
          text: prompt + (text ? `\n\nTexte extrait de la facture :\n${text.slice(0, 3000)}` : ""),
        });

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
          body: JSON.stringify({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            max_tokens: 1500,
            messages: [{ role: "user", content: userContent }],
          }),
        });

        if (res.ok) {
          const resData = await res.json();
          const content = resData.choices?.[0]?.message?.content ?? "{}";
          console.log("[OCR] Groq response:", content.slice(0, 500));
          const matchJson = content.match(/\{[\s\S]*\}/);
          if (matchJson) {
            const ai = JSON.parse(matchJson[0]);
            result = {
              ...result,
              client_nom_extrait:         ai.client_nom                          ?? "",
              ice_client:                 ai.client_ice                          ?? null,
              numero_facture:             ai.numero                              ?? null,
              date_facture:               ai.date                                ?? null,
              date_echeance:              ai.date_echeance                       ?? null,
              montant_ht:                 Number(ai.montant_ht)                  || 0,
              montant_tva:                Number(ai.montant_tva)                 || 0,
              montant_ttc:                Number(ai.montant_ttc)                 || 0,
              type_facture:               ai.type_facture                        ?? "standard",
              numero_commande:            ai.numero_commande                     ?? null,
              numero_acompte:             ai.numero_acompte                      ?? null,
              montant_commande_total_ht:  Number(ai.montant_commande_total_ht)   || null,
              montant_commande_total_ttc: Number(ai.montant_commande_total_ttc)  || null,
              montant_restant_du:         Number(ai.montant_restant_du)          || null,
              lignes: (ai.lignes ?? []).map((l: any) => ({
                designation:   l.description ?? l.designation                       ?? "Prestation",
                quantite:      Number(l.quantite)                                   || 1,
                prix_unitaire: Number(l.prix_unitaire_ht ?? l.prix_unitaire)        || 0,
                taux_tva:      Number(l.taux_tva)                                   || 20,
              })),
            };
            confidence = "high";
            method     = "ai";
            if (!result.delai_paiement_jours) result.delai_paiement_jours = 30;
            if (!result.date_echeance && result.date_facture) {
              const dateF = new Date(result.date_facture);
              dateF.setDate(dateF.getDate() + (result.delai_paiement_jours ?? 30));
              const ech = dateF.toISOString().slice(0, 10);
              if (ech > result.date_facture) result.date_echeance = ech;
            }
          }
        } else {
          const err = await res.text();
          console.log("[OCR] Groq error:", res.status, err.slice(0, 200));
        }
      } catch (e) { console.log("[OCR] exception:", String(e)); }
    }

    // ── Regex fallback — complète UNIQUEMENT les champs manquants ────────────
    // FIX : exclure les numéros fiscaux (IF, RC, CNSS, ICE, TP) des montants
    if (!result.ice_client) {
      // ICE client : 15 chiffres après "Client" ou "CE :"
      result.ice_client = norm.match(/(?:client|CE)\s*[:\-]?\s*.*?(\d{15})/i)?.[1] ?? null;
    }
    if (!result.numero_facture) {
      result.numero_facture = norm.match(/(?:n°\s*facture|facture\s*n°|numéro)\s*[:\-]?\s*([A-Z0-9\/\-]+)/i)?.[1] ?? null;
    }
    // Regex montants : uniquement si Groq n'a rien trouvé
    if ((!result.montant_ttc || result.montant_ttc === 0) && method === "regex") {
      // Cherche uniquement les montants MAD/DH explicites ou formats X XXX,XX
      // Exclut les numéros fiscaux (IF, RC, CNSS, TP) qui sont < 10 chiffres sans virgule
      const montantRegex = /\b(\d{1,3}(?:[\s.]\d{3})*[,\.]\d{2})\s*(?:MAD|DH|Dhs)?\b/g;
      const amounts = [...norm.matchAll(montantRegex)]
        .map(m => parseFloat(m[1].replace(/[\s.]/g, "").replace(",", ".")))
        .filter(n => !isNaN(n) && n >= 10 && n < 10_000_000)
        .sort((a, b) => b - a);
      if (amounts[0]) {
        result.montant_ttc = amounts[0];
        result.montant_ht  = amounts[1] ?? Math.round(amounts[0] / 1.2 * 100) / 100;
        result.montant_tva = Math.round((result.montant_ttc - result.montant_ht) * 100) / 100;
      }
    }
    if (!result.lignes?.length && result.montant_ttc > 0) {
      result.lignes = [{
        designation: "Prestation (à préciser)",
        quantite: 1,
        prix_unitaire: result.montant_ht,
        taux_tva: 20,
      }];
    }

    // ── Résolution client en base ─────────────────────────────────────────────
    let client_id: string | null = null;
    let client_action: "found" | "created" | "not_found" = "not_found";
    let client_trouve: any = null;
    const nomClient = result.client_nom_extrait?.trim();
    const iceClient = result.ice_client?.trim();

    if (nomClient || iceClient) {
      if (iceClient) {
        const { data: byIce } = await supabase.from("clients").select("*")
          .eq("dossier_id", data.dossier_id).eq("ice", iceClient)
          .is("deleted_at", null).maybeSingle();
        if (byIce) { client_id = byIce.id; client_action = "found"; client_trouve = byIce; }
      }
      if (!client_id && nomClient) {
        const { data: byNom } = await supabase.from("clients").select("*")
          .eq("dossier_id", data.dossier_id).ilike("nom", `%${nomClient.slice(0, 25)}%`)
          .is("deleted_at", null).maybeSingle();
        if (byNom) {
          const updates: any = {};
          if (!byNom.ice && iceClient) updates.ice = iceClient;
          if (Object.keys(updates).length > 0) await supabase.from("clients").update(updates).eq("id", byNom.id);
          client_id = byNom.id; client_action = "found"; client_trouve = { ...byNom, ...updates };
        }
      }
      if (!client_id) {
        const { data: nouveau, error: ce } = await supabase.from("clients").insert({
          dossier_id: data.dossier_id,
          nom: nomClient || `Client ICE ${iceClient}`,
          ice: iceClient ?? null,
          if_fiscal: result.if_fiscal_client ?? null,
          rc: result.rc_client ?? null,
        }).select().single();
        if (nouveau) { client_id = nouveau.id; client_action = "created"; client_trouve = nouveau; }
        else console.log("[OCR] Erreur création client:", ce?.message);
      }
    }

    console.log("[OCR] final:", {
      confidence, method, client_action,
      client: result.client_nom_extrait,
      ttc: result.montant_ttc,
      type_facture: result.type_facture,
      restant: result.montant_restant_du,
    });

    return { result: { ...result, confidence, method, client_id, client_action, client_trouve } };
  });
