import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, CheckCircle, X, RefreshCw, Download, AlertCircle, FileText, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const Route = createFileRoute("/_app/dossiers/$dossierId/relevescanner")({
  component: RelEveScanner,
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface Transaction {
  id: string;
  ligne: number;
  date_operation: string;
  date_valeur: string;
  reference: string;
  nature_operation: string;
  montant_debit: number | null;
  montant_credit: number | null;
  nature_confirmee: string;
  document_reference: string;
  debiteur_crediteur: string;
  code_comptable: string;
  montant_ht: number | null;
  montant_tva: number | null;
  taux_tva: number;
  confiance: number;
  valide: boolean;
  remarque: string;
  alerte: string | null;
  necessite_remarque: boolean;
  message_pour_comptable: string | null;
  etape_rapprochement: string;
  facture_id: string | null;
  suggestions: Array<{ nature: string; code_pcm: string; tiers: string | null; facture: string | null; confiance: number }>;
}

interface InfoReleve {
  banque: string;
  rib: string;
  solde_initial: number;
  solde_final: number;
}

// ── PCM Marocain ──────────────────────────────────────────────────────────────

const NATURES_OPERATION = [
  { value: "encaissement_client",  label: "Encaissement client",    code: "3421", tva: false },
  { value: "paiement_fournisseur", label: "Paiement fournisseur",   code: "4411", tva: true  },
  { value: "salaires",             label: "Paiement salaires",      code: "6171", tva: false },
  { value: "cnss_amo",             label: "CNSS / AMO",             code: "6174", tva: false },
  { value: "tva_dgi",              label: "TVA / Impôts DGI",       code: "4456", tva: false },
  { value: "loyers",               label: "Loyer / Location",       code: "6131", tva: true  },
  { value: "eau_electricite",      label: "Eau / Électricité ONEE", code: "6125", tva: true  },
  { value: "telecom",              label: "Téléphone / Internet",   code: "6132", tva: true  },
  { value: "gasoil",               label: "Gasoil / Carburant",     code: "6122", tva: true  },
  { value: "assurance",            label: "Assurance",              code: "6161", tva: false },
  { value: "entretien",            label: "Entretien / Réparation", code: "6141", tva: true  },
  { value: "frais_bancaires",      label: "Frais bancaires",        code: "6347", tva: false },
  { value: "taxe_professionnelle", label: "Taxe Professionnelle",   code: "6313", tva: false },
  { value: "retrait_especes",      label: "Retrait espèces / GAB",  code: "5161", tva: false },
  { value: "interets_crediteurs",  label: "Intérêts créditeurs",    code: "7611", tva: false },
  { value: "frais_representation",  label: "Frais de représentation", code: "6147", tva: false },
  { value: "frais_douane",           label: "Frais douane / import",   code: "6146", tva: false },
  { value: "autre",                  label: "Autre opération",          code: "6141", tva: false },
];

// ── Server function Groq ──────────────────────────────────────────────────────

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
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) throw new Error("GROQ_API_KEY manquante");

    const facturesClientData = data.factures_client.map((f: any) => ({
      id: f.id,
      num: f.numero,
      client: f.clients?.nom,
      client_ice: f.clients?.ice,
      ttc: Number(f.montant_ttc),
      ht: Number(f.montant_ht),
      tva: Number(f.montant_tva),
      date_echeance: f.date_echeance || null,
    }));

    const facturesFournData = data.factures_fourn.map((f: any) => ({
      id: f.id,
      num: f.numero,
      fournisseur: f.fournisseur_nom,
      ttc: Number(f.montant_ttc),
      ht: Number(f.montant_ht),
      tva: Number(f.montant_tva),
      date_echeance: f.date_echeance || null,
    }));

    const prompt = `Tu es expert-comptable marocain certifié (PCM/CGNC). Analyse ces transactions bancaires et effectue un rapprochement comptable précis.

═══════════════════════════════════════════════════════
CONTEXTE — SOCIÉTÉ DU DOSSIER
═══════════════════════════════════════════════════════
Société : "${data.dossier_nom}" (ICE: ${data.dossier_ice || "non renseigné"})
Ce relevé bancaire appartient à cette société. Les CRÉDITS (entrées d'argent) sont des encaissements clients. Les DÉBITS (sorties) sont des paiements fournisseurs ou charges.

═══════════════════════════════════════════════════════
FACTURES CLIENTS NON ENCAISSÉES (à rapprocher avec crédits)
═══════════════════════════════════════════════════════
${JSON.stringify(facturesClientData)}

═══════════════════════════════════════════════════════
FACTURES FOURNISSEURS NON PAYÉES (à rapprocher avec débits)
═══════════════════════════════════════════════════════
${JSON.stringify(facturesFournData)}

CLIENTS CONNUS: ${JSON.stringify(data.clients.map((c: any) => ({ nom: c.nom, ice: c.ice })))}
FOURNISSEURS CONNUS: ${JSON.stringify(data.fournisseurs.map((f: any) => ({ nom: f.nom, ice: f.ice })))}

${data.remarques ? `REMARQUES COMPTABLE (PRIORITÉ ABSOLUE):\n${data.remarques}\n` : ""}

═══════════════════════════════════════════════════════
TRANSACTIONS À ANALYSER
═══════════════════════════════════════════════════════
${JSON.stringify(data.transactions_brutes.map((tx: any) => ({
  ligne: tx.ligne,
  date: tx.date_operation,
  libelle: tx.nature_operation,
  debit: tx.montant_debit,
  credit: tx.montant_credit,
})))}

═══════════════════════════════════════════════════════
ALGORITHME DE RAPPROCHEMENT (ordre strict de priorité)
═══════════════════════════════════════════════════════
1. REMARQUES COMPTABLE → confiance 100%
2. NUMÉRO FACTURE dans libellé (ex: "FAC2024-001", "F-123") → confiance 95%
   → Cherche dans la liste des factures clients ET fournisseurs
   → Si trouvé, retourner facture_id (l'id UUID de la facture correspondante)
3. NOM TIERS dans libellé (tolérer abréviations, 3+ lettres communes) → confiance 85%
   → Ex: "ATLAS" dans libellé → cherche client/fournisseur "ATLAS TRADING SARL"
   → Si trouvé et montant compatible → retourner facture_id
4. MONTANT TTC EXACT + DATE COHÉRENTE → confiance 80%
   → Facture avec montant_ttc = montant transaction (±1 MAD)
   → Date transaction ≤ date_echeance facture (ou date_facture + 45j)
   → Retourner facture_id si match trouvé
5. MOTS-CLÉS PCM → confiance 70%
   → CNSS/AMO → 6174 (tva 0%) | TVA/IR/IS/DGI → 4456 (tva 0%)
   → IAM/INWI/ORANGE/TELECOM → 6132 (tva 20%) | LOYER/LOCATION → 6131 (tva 20%)
   → GASOIL/CARBURANT → 6122 (tva 20%) | SALAIRE/VIREMENT SALAIRE → 6171 (tva 0%)
   → EAU/ONEE/AMENAU → 6125 (tva 7%) | ELECTRICITE/ONEE → 6125 (tva 14%)
   → ASSURANCE → 6161 (tva 0%) | FRAIS BANCAIRES/COMMISSION → 6347 (tva 10%)
   → RETRAIT/GAB/ESPECES → 5161 (tva 0%) | INTERETS CREDITEURS → 7611 (tva 0%)
   → IMPORT/DOUANE → 6146 (tva 0%) | ENTRETIEN/REPARATION → 6141 (tva 20%)
6. DIRECTION D'ARGENT → confiance 60%
   → credit (argent reçu) = encaissement_client → code 3421
   → debit (argent sorti) = paiement_fournisseur → code 4411
7. INCONNU → necessite_remarque=true avec message clair au comptable

RÈGLE CRITIQUE DÉBIT/CRÉDIT:
- transaction.credit > 0 → argent ENTRANT = encaissement client (compte 3421)
- transaction.debit > 0 → argent SORTANT = paiement (fournisseur, charges, etc.)

Réponds UNIQUEMENT avec ce JSON valide:
{"analyses":[{"ligne":number,"nature_principale":"encaissement_client|paiement_fournisseur|salaires|cnss_amo|tva_dgi|loyers|eau_electricite|telecom|gasoil|assurance|entretien|frais_bancaires|frais_representation|frais_douane|retrait_especes|interets_crediteurs|virement_interne|autre","code_pcm":"string","tiers_nom":"string|null","tiers_type":"client|fournisseur|employe|etat|banque|autre","facture_num":"string|null","facture_id":"string|null","montant_ht":number|null,"montant_tva":number|null,"taux_tva":0|7|10|14|20,"confiance":number,"etape_rapprochement":"remarques|numero_facture|nom_tiers|montant_date|mots_cles|direction|inconnu","alerte":"string|null","necessite_remarque":boolean,"message_pour_comptable":"string|null","suggestions":[{"nature":"string","code_pcm":"string","tiers":"string|null","facture":"string|null","confiance":number}]}]}`;

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const err = await res.json() as { error?: { message?: string } };
      throw new Error(`Groq: ${err.error?.message ?? "erreur"}`);
    }

    const groqData = await res.json() as { choices: Array<{ message: { content: string } }> };
    let content = groqData.choices[0].message.content;
    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(content) as { analyses: any[] };
  });

// ── Composant ─────────────────────────────────────────────────────────────────

function RelEveScanner() {
  const { dossierId } = Route.useParams();

  const [step, setStep] = useState<"upload" | "scan" | "review" | "done">("upload");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [infoReleve, setInfoReleve] = useState<InfoReleve | null>(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [remarques, setRemarques] = useState("");
  const [showRemarques, setShowRemarques] = useState(false);
  const [selectedTx, setSelectedTx] = useState<number | null>(null);
  const [factures, setFactures] = useState<any[]>([]);
  const [facturesFourn, setFacturesFourn] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [dossier, setDossier] = useState<{ nom_societe: string; ice: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([
      supabase.from("factures").select("id,numero,montant_ht,montant_ttc,montant_tva,date_facture,date_echeance,clients(id,nom,ice)").eq("dossier_id", dossierId).eq("statut", "conforme").neq("statut_paiement", "payee"),
      (supabase as any).from("factures_fournisseurs").select("id,numero,montant_ht,montant_ttc,montant_tva,date_facture,date_echeance,fournisseur_nom,fournisseur_id").eq("dossier_id", dossierId).neq("statut_paiement", "payee"),
      (supabase as any).from("fournisseurs").select("id,nom,ice").eq("dossier_id", dossierId),
      supabase.from("clients").select("id,nom,ice").eq("dossier_id", dossierId),
      supabase.from("dossiers").select("nom_societe,ice").eq("id", dossierId).single(),
    ]).then(([{ data: f }, { data: ff }, { data: fo }, { data: cl }, { data: dos }]) => {
      setFactures(f ?? []);
      setFacturesFourn(ff ?? []);
      setFournisseurs(fo ?? []);
      setClients(cl ?? []);
      setDossier(dos ?? null);
    });
  }, [dossierId]);

  const parserTransactions = (text: string): any[] => {
    const txs: any[] = [];
    const year = new Date().getFullYear();

    // Mots à exclure (en-têtes, pieds de page, totaux)
    const EXCL = [
      "solde a reporter", "ancien solde", "solde depart", "nouveau solde", "solde final",
      "total des", "total mouvements", "banque populaire", "attijariwafa", "cih bank", "bmci",
      "agence", "adresse", "extrait de compte", "releve de compte", "releve bancaire",
      "code banque", "code agence", "date oper", "date valeur", "libelle", "debit", "credit",
      "montant", "page n", "page:", "www.", "sa au capital", "ice :", "rc :", "if :",
      "numéro de compte", "numero de compte", "rib :", "rib:", "titulaire",
    ];

    // Mots-clés qui signalent un CRÉDIT (argent entrant)
    const CREDIT_KEYWORDS = [
      "VIRT RECU", "VIREMENT RECU", "VERSEMENT ESPECE", "VERSEMENT ESP",
      "REMISE CHEQUE", "REMISE CHQ", "RECU", "ENCAISSEMENT", "RETROCESSION",
      "INTERETS CREDITEURS", "INTERETS CREDIT", "AVOIR", "REMBOURSEMENT",
      "DEPOT", "RECOUVREMENT", "CREDIT VIREMENT", "CREDIT ESPECES",
      "AVIS DE CREDIT", "TRANSFERT RECU",
    ];

    const lines = text.split(/\n/).map((l: string) => l.trim()).filter((l: string) => l.length > 5);

    // ─── Stratégie 1 : lignes avec date DD/MM ou DD/MM/YYYY ou DD MM YYYY ──────
    // Couvre BP (deux dates), CIH (DD/MM), ATW (référence + DD MM), BMCI (DD/MM/YYYY)
    const DATE_PATTERNS = [
      // BP: "15 03 2024 17 03 2024 VIREMENT ..."
      /^(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{2})\s+(\d{2})\s+(\d{4})\s+(.*)/,
      // YYYY-MM-DD ou YYYY/MM/DD
      /^(\d{4})[-\/](\d{2})[-\/](\d{2})\s+(.*)/,
      // DD/MM/YYYY ou DD-MM-YYYY
      /^(\d{2})[\/\-](\d{2})[\/\-](\d{4})\s+(.*)/,
      // DD/MM ou DD-MM (CIH, sans année)
      /^(\d{2})[\/\-](\d{2})\s+(.*)/,
      // ATW: référence alphanumérique + DD MM  (ex: "VIR0001 15 03 ...")
      /^[A-Z0-9]{4,12}\s+(\d{2})\s+(\d{2})\s+(.*)/,
    ];

    const parsed: Array<{ date: string; libelle_raw: string; line: string }> = [];

    for (const line of lines) {
      const low = line.toLowerCase();
      if (EXCL.some(e => low.includes(e))) continue;
      if (/^[\u0600-\u06FF\s,\.]+$/.test(line)) continue; // lignes arabes
      if (/^\*+$/.test(line) || /^-{3,}$/.test(line)) continue; // séparateurs

      let date = "";
      let libelle_raw = line;

      // Essai BP (2 dates complètes)
      const mBP = line.match(/^(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{2})\s+(\d{2})\s+(\d{4})\s+(.*)/);
      if (mBP) { date = `${mBP[1]}/${mBP[2]}/${mBP[3]}`; libelle_raw = mBP[7]; }

      // Essai YYYY-MM-DD
      if (!date) {
        const mISO = line.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})\s+(.*)/);
        if (mISO) { date = `${mISO[3]}/${mISO[2]}/${mISO[1]}`; libelle_raw = mISO[4]; }
      }

      // Essai DD/MM/YYYY ou DD-MM-YYYY
      if (!date) {
        const mFull = line.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})\s+(.*)/);
        if (mFull) { date = `${mFull[1]}/${mFull[2]}/${mFull[3]}`; libelle_raw = mFull[4]; }
      }

      // Essai DD/MM (CIH sans année)
      if (!date) {
        const mShort = line.match(/^(\d{2})[\/\-](\d{2})\s+(.*)/);
        if (mShort && Number(mShort[1]) <= 31 && Number(mShort[2]) <= 12) {
          date = `${mShort[1]}/${mShort[2]}/${year}`; libelle_raw = mShort[3];
        }
      }

      // Essai ATW (code ref + DD MM)
      if (!date) {
        const mATW = line.match(/^[A-Z0-9]{4,12}\s+(\d{2})\s+(\d{2})\s+(.*)/);
        if (mATW && Number(mATW[1]) <= 31 && Number(mATW[2]) <= 12) {
          date = `${mATW[1]}/${mATW[2]}/${year}`; libelle_raw = mATW[3];
        }
      }

      // Si aucune date trouvée mais on a une ligne précédente → continuation
      if (!date) {
        if (parsed.length > 0) {
          const hasAmount = /\d{1,3}(?:\s\d{3})*[,\.]\d{2}/.test(line);
          if (!hasAmount) {
            parsed[parsed.length - 1].libelle_raw += " " + line;
          }
        }
        continue;
      }

      parsed.push({ date, libelle_raw, line });
    }

    // ─── Extraction montant + débit/crédit ────────────────────────────────────
    let ligneNum = 1;
    for (const { date, libelle_raw, line } of parsed) {
      // Normalise les montants collés (ex: "1 234,56" ou "1234,56" ou "1.234,56")
      const fixed = libelle_raw.replace(/(\d+,\d)\s+(\d)\b/g, "$1$2");

      // Extraction de tous les montants valides (format marocain: X XXX,XX ou X.XXX,XX)
      const amountMatches = [
        ...(fixed.matchAll(/\b(\d{1,3}(?:[\s.]\d{3})*),(\d{2})\b/g)),
        ...(fixed.matchAll(/(?<![,\d])(\d{2,8}),(\d{2})(?!\d)/g)),
      ];
      const amounts = amountMatches
        .map(m => parseFloat(m[1].replace(/[\s.]/g, "") + "." + m[2]))
        .filter(n => !isNaN(n) && n >= 1 && n < 50_000_000);

      if (!amounts.length) continue;

      // Le dernier montant est généralement le solde ou le montant principal
      // Prendre le plus grand montant non-solde (souvent avant-dernier ou dernier)
      const montant = amounts[amounts.length - 1] > 0 ? amounts[amounts.length - 1] : amounts[0];
      if (!montant || montant <= 0) continue;

      // Nettoyage du libellé (enlever dates et montants)
      let libelle = fixed
        .replace(/\b\d{1,3}(?:[\s.]\d{3})*,\d{2}\b/g, "")
        .replace(/(?<![,\d])\d{2,8},\d{2}(?!\d)/g, "")
        .replace(/^\d{2}[\/\-\s]\d{2}([\/\-\s]\d{2,4})?\s*/g, "")
        .replace(/\s{2,}/g, " ").trim().slice(0, 120);

      if (!libelle || libelle.length < 2) libelle = "Transaction bancaire";

      // Détection CRÉDIT (argent entrant) par mots-clés
      const up = (line + " " + libelle_raw).toUpperCase();
      const isCredit = CREDIT_KEYWORDS.some(kw => up.includes(kw));

      txs.push({
        ligne: ligneNum++,
        date_operation: date,
        date_valeur: date,
        reference: "",
        nature_operation: libelle,
        montant_debit: isCredit ? null : montant,
        montant_credit: isCredit ? montant : null,
      });
    }

    return txs;
  };

  const parserInfoReleve = (text: string): InfoReleve => {
    const lower = text.toLowerCase();
    const banque = lower.includes("attijariwafa") ? "Attijariwafa Bank"
      : lower.includes("banque populaire") ? "Banque Populaire"
      : lower.includes("cih") ? "CIH Bank" : "Banque";
    const mRib = text.match(/(\d{3})\s+(\d{3})\s+([\d\s]+)\s+(\d{2})/);
    const mInit = text.match(/(?:SOLDE DEPART|ANCIEN SOLDE)[\s\S]*?([\d\s]+,\d{2})/i);
    const mFin  = text.match(/(?:SOLDE A REPORTER|NOUVEAU SOLDE)[\s\S]{0,50}([\d\s]+,\d{2})/i);
    const parse = (s?: string) => s ? parseFloat(s.replace(/\s/g, "").replace(",", ".")) : 0;
    return {
      banque,
      rib: mRib ? `${mRib[1]} ${mRib[2]} ${mRib[3].trim()} ${mRib[4]}` : "",
      solde_initial: parse(mInit?.[1]),
      solde_final:   parse(mFin?.[1]),
    };
  };

  const lancerScan = async (file: File, remarquesExtra = "") => {
    setScanning(true);
    try {
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
      const ab = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map((x: any) => x.str).join(" ") + "\n";
      }

      const txBrutes = parserTransactions(fullText);
      setInfoReleve(parserInfoReleve(fullText));

      const result = await analyserTransactions({
        data: {
          dossier_id: dossierId,
          dossier_nom: dossier?.nom_societe ?? "",
          dossier_ice: dossier?.ice ?? "",
          transactions_brutes: txBrutes,
          factures_client: factures,
          factures_fourn: facturesFourn,
          fournisseurs,
          clients,
          remarques: remarquesExtra || remarques,
        },
      });

      const txFinal: Transaction[] = txBrutes.map((tx: any, idx: number) => {
        const a = result.analyses.find((x: any) => x.ligne === tx.ligne) ?? result.analyses[idx] ?? {};
        const nature = NATURES_OPERATION.find(n => n.value === a.nature_principale);
        return {
          id: `tx_${idx}`,
          ligne: tx.ligne,
          date_operation: tx.date_operation,
          date_valeur: tx.date_valeur,
          reference: tx.reference ?? "",
          nature_operation: tx.nature_operation,
          montant_debit: tx.montant_debit,
          montant_credit: tx.montant_credit,
          nature_confirmee: a.nature_principale ?? "autre",
          document_reference: a.facture_num ?? "",
          debiteur_crediteur: a.tiers_nom ?? "",
          code_comptable: a.code_pcm ?? nature?.code ?? "6141",
          montant_ht: a.montant_ht ?? null,
          montant_tva: a.montant_tva ?? null,
          taux_tva: a.taux_tva ?? 0,
          confiance: a.confiance ?? 50,
          valide: (a.confiance ?? 0) >= 90,
          remarque: "",
          alerte: a.alerte ?? null,
          necessite_remarque: a.necessite_remarque ?? false,
          message_pour_comptable: a.message_pour_comptable ?? null,
          etape_rapprochement: a.etape_rapprochement ?? 'inconnu',
          facture_id: a.facture_id ?? null,
          suggestions: a.suggestions ?? [],
        };
      });

      setTransactions(txFinal);
      setStep("review");
    } catch (e: any) {
      toast.error("Erreur scan : " + e.message);
      setStep("upload");
    } finally {
      setScanning(false);
    }
  };

  const handleUpload = async (file: File) => {
    setPdfFile(file);
    setPdfUrl(URL.createObjectURL(file));
    setStep("scan");
    await lancerScan(file);
  };

  const updateTx = (idx: number, updates: Partial<Transaction>) => {
    setTransactions(prev => prev.map((tx, i) => {
      if (i !== idx) return tx;
      const updated = { ...tx, ...updates };
      if (updates.nature_confirmee) {
        const nature = NATURES_OPERATION.find(n => n.value === updates.nature_confirmee);
        if (nature) {
          updated.code_comptable = nature.code;
          const montant = tx.montant_debit ?? tx.montant_credit ?? 0;
          if (nature.tva && montant > 0) {
            const taux = updated.taux_tva || 20;
            updated.montant_ht  = Math.round(montant / (1 + taux / 100) * 100) / 100;
            updated.montant_tva = Math.round((montant - updated.montant_ht) * 100) / 100;
          } else {
            updated.montant_ht  = montant;
            updated.montant_tva = null;
          }
        }
      }
      return updated;
    }));
  };

  const handleValider = async () => {
    const nonValidees = transactions.filter(tx => !tx.valide);
    if (nonValidees.length > 0) {
      const ok = window.confirm(`${nonValidees.length} transaction(s) non validées. Continuer ?`);
      if (!ok) return;
    }
    setSaving(true);
    try {
      const ecritures: any[] = [];
      const facturesClientPayees: string[] = [];
      const facturesFournPayees: string[] = [];

      for (const tx of transactions.filter(t => t.valide)) {
        const dateParts = tx.date_operation.includes("/")
          ? tx.date_operation.split("/")
          : tx.date_operation.split("-");
        const date = dateParts.length === 3
          ? (dateParts[2].length === 4
            ? `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`
            : tx.date_operation)
          : tx.date_operation;

        const montant = tx.montant_credit ?? tx.montant_debit ?? 0;
        const libelle = (tx.debiteur_crediteur
          ? `${tx.nature_operation} - ${tx.debiteur_crediteur}`
          : tx.nature_operation).slice(0, 100);
        const ht  = tx.montant_ht  ?? montant;
        const tva = tx.montant_tva ?? 0;

        // Banque 5141
        ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: "5141", date_ecriture: date, libelle, debit: tx.montant_credit ? montant : 0, credit: tx.montant_debit ? montant : 0, reference_piece: tx.document_reference || tx.reference, valide: true });

        // Contre-écriture avec TVA
        if (tva > 0 && tx.montant_debit) {
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: tx.code_comptable, date_ecriture: date, libelle, debit: ht, credit: 0, reference_piece: tx.document_reference, valide: true });
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: "34552", date_ecriture: date, libelle: `TVA ${libelle.slice(0, 50)}`, debit: tva, credit: 0, reference_piece: tx.document_reference, valide: true });
        } else {
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: tx.code_comptable, date_ecriture: date, libelle, debit: tx.montant_debit ? 0 : ht, credit: tx.montant_credit ? 0 : ht, reference_piece: tx.document_reference, valide: true });
        }

        // Rapprochement facture — marquer comme payée
        if (tx.facture_id) {
          if (tx.nature_confirmee === "encaissement_client" && tx.montant_credit) {
            facturesClientPayees.push(tx.facture_id);
          } else if (tx.nature_confirmee === "paiement_fournisseur" && tx.montant_debit) {
            facturesFournPayees.push(tx.facture_id);
          }
        }
      }

      await supabase.from("ecritures_comptables").insert(ecritures);

      // Marquer les factures clients rapprochées comme payées
      if (facturesClientPayees.length > 0) {
        await supabase.from("factures")
          .update({ statut_paiement: "payee", date_paiement: new Date().toISOString().slice(0, 10) })
          .in("id", facturesClientPayees);
      }

      // Marquer les factures fournisseurs rapprochées comme payées
      if (facturesFournPayees.length > 0) {
        await (supabase as any).from("factures_fournisseurs")
          .update({ statut_paiement: "payee", date_paiement: new Date().toISOString().slice(0, 10) })
          .in("id", facturesFournPayees);
      }

      const nbPayees = facturesClientPayees.length + facturesFournPayees.length;
      toast.success(
        `${transactions.filter(t => t.valide).length} transactions comptabilisées` +
        (nbPayees > 0 ? ` — ${nbPayees} facture(s) marquée(s) payée(s)` : "")
      );
      setStep("done");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const genererEDI = () => {
    const txFourn = transactions.filter(tx => tx.valide && tx.nature_confirmee === "paiement_fournisseur" && tx.montant_debit);
    if (!txFourn.length) { toast.warning("Aucune transaction fournisseur validée"); return; }
    const rows = [["OR","FACT_NUM","DESIGNATION","M_HT","TVA","M_TTC","IF","LIB_FRSS","ICE_FRS","TAUX","ID_PAIE","DATE_PAIE","DATE_FAC"]];
    txFourn.forEach((tx, i) => {
      const fourn = (fournisseurs as any[]).find(f => f.nom === tx.debiteur_crediteur);
      rows.push([String(i+1), tx.document_reference||"—", tx.nature_operation.slice(0,50), String(tx.montant_ht??tx.montant_debit??0), String(tx.montant_tva??0), String(tx.montant_debit??0), fourn?.if||"", tx.debiteur_crediteur||"FOURNISSEUR", fourn?.ice||"", String(tx.taux_tva||20), String(i+1), tx.date_operation, tx.date_valeur]);
    });
    const blob = new Blob(["\uFEFF" + rows.map(r => r.join(";")).join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `EDI_DGI_${new Date().toISOString().slice(0,7)}.csv`; a.click();
    toast.success("Fichier EDI DGI généré");
  };

  const genererBilan = () => {
    const rows = [["Date","Journal","Compte","Libellé","Débit","Crédit","Réf."]];
    for (const tx of transactions.filter(t => t.valide)) {
      const montant = tx.montant_credit ?? tx.montant_debit ?? 0;
      const libelle = `${tx.nature_operation} - ${tx.debiteur_crediteur}`;
      const ht  = tx.montant_ht  ?? montant;
      const tva = tx.montant_tva ?? 0;
      rows.push([tx.date_operation, "BQ", "5141", libelle, tx.montant_credit?String(montant):"", tx.montant_debit?String(montant):"", tx.document_reference]);
      if (tva > 0 && tx.montant_debit) {
        rows.push([tx.date_operation, "BQ", tx.code_comptable, libelle, String(ht), "", tx.document_reference]);
        rows.push([tx.date_operation, "BQ", "34552", `TVA ${libelle}`, String(tva), "", tx.document_reference]);
      } else {
        rows.push([tx.date_operation, "BQ", tx.code_comptable, libelle, tx.montant_debit?"":String(ht), tx.montant_credit?"":String(ht), tx.document_reference]);
      }
    }
    const blob = new Blob(["\uFEFF" + rows.map(r => r.join(";")).join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `Bilan_Sage_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    toast.success("Fichier bilan Sage généré");
  };

  const resetAll = () => { setStep("upload"); setPdfUrl(null); setPdfFile(null); setTransactions([]); setInfoReleve(null); setSelectedTx(null); };
  const getNatureLabel = (v: string) => NATURES_OPERATION.find(n => n.value === v)?.label ?? v;
  const confColor = (c: number) => c >= 90 ? "text-green-600" : c >= 70 ? "text-yellow-500" : "text-red-500";
  const nbValides = transactions.filter(t => t.valide).length;
  const nbAlertes = transactions.filter(t => !!t.alerte).length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-background">

      {/* Header */}
      <div className="border-b px-6 py-3 flex items-center justify-between bg-card shrink-0">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-primary" />
          <div>
            <h1 className="font-bold text-base">Scanner de relevé bancaire</h1>
            {infoReleve && <p className="text-xs text-muted-foreground">{infoReleve.banque} {infoReleve.rib ? `— ${infoReleve.rib}` : ""}</p>}
          </div>
          {step === "review" && (
            <div className="flex gap-2 ml-4">
              <Badge variant="outline" className="text-xs">{transactions.length} transactions</Badge>
              <Badge className="text-xs bg-green-600">{nbValides} validées</Badge>
              {nbAlertes > 0 && <Badge variant="destructive" className="text-xs">{nbAlertes} alertes</Badge>}
            </div>
          )}
        </div>

        {step === "review" && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowRemarques(true)}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />Rescanner
            </Button>
            <Button variant="outline" size="sm" onClick={genererBilan}>
              <Download className="h-3.5 w-3.5 mr-1.5" />Bilan Sage
            </Button>
            <Button variant="outline" size="sm" onClick={genererEDI}>
              <Download className="h-3.5 w-3.5 mr-1.5" />EDI DGI
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTransactions(prev => prev.map(tx => ({ ...tx, valide: true })))}>
              <CheckCircle className="h-3.5 w-3.5 mr-1.5" />Valider tout
            </Button>
            <Button size="sm" onClick={handleValider} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5 mr-1.5" />}
              Valider écriture
            </Button>
            <Button variant="ghost" size="sm" onClick={resetAll}>
              <X className="h-3.5 w-3.5 mr-1.5" />Annuler
            </Button>
          </div>
        )}
      </div>

      {/* Upload */}
      {step === "upload" && (
        <div className="flex-1 flex items-center justify-center">
          <div
            className="border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer hover:border-primary transition-all max-w-lg w-full mx-4"
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleUpload(f); }}>
            <input ref={fileRef} type="file" className="hidden" accept=".pdf"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <p className="font-semibold text-lg mb-1">Importez votre relevé bancaire</p>
            <p className="text-sm text-muted-foreground mb-4">PDF — CIH, Attijariwafa, Banque Populaire, BMCI</p>
            <Button>Sélectionner le fichier PDF</Button>
          </div>
        </div>
      )}

      {/* Scan en cours */}
      {step === "scan" && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary mb-4" />
            <p className="font-semibold text-lg">Analyse en cours…</p>
            <p className="text-sm text-muted-foreground mt-1">Extraction + Classification IA (Groq)</p>
          </div>
        </div>
      )}

      {/* Review split-screen */}
      {step === "review" && (
        <div className="flex-1 flex overflow-hidden">

          {/* Gauche : tableau transactions */}
          <div className="flex-1 overflow-y-auto border-r flex flex-col">

            {/* En-tête colonnes */}
            <div className="sticky top-0 bg-muted/90 backdrop-blur border-b px-4 py-2 grid grid-cols-12 gap-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide z-10 shrink-0">
              <div className="col-span-1">#</div>
              <div className="col-span-1">Date</div>
              <div className="col-span-2">Nature</div>
              <div className="col-span-2">Doc. référence</div>
              <div className="col-span-2">Débiteur / Créditeur</div>
              <div className="col-span-1">Code PCM</div>
              <div className="col-span-1 text-right">HT</div>
              <div className="col-span-1 text-right">TVA</div>
              <div className="col-span-1 text-right">TTC</div>
            </div>

            {/* Lignes */}
            <div className="flex-1 overflow-y-auto">
              {transactions.map((tx, idx) => (
                <div
                  key={tx.id}
                  className={`border-b px-4 py-2 cursor-pointer transition-colors ${selectedTx === idx ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/30"}`}
                  onClick={() => setSelectedTx(selectedTx === idx ? null : idx)}>

                  <div className="grid grid-cols-12 gap-1 items-center">
                    {/* # + statut */}
                    <div className="col-span-1 flex items-center gap-1">
                      <span className="text-xs font-mono text-muted-foreground">{tx.ligne}</span>
                      {tx.valide
                        ? <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />
                        : <AlertCircle className="h-3 w-3 text-yellow-500 shrink-0" />}
                    </div>

                    {/* Date */}
                    <div className="col-span-1 text-xs font-mono text-muted-foreground">{tx.date_operation}</div>

                    {/* Nature */}
                    <div className="col-span-2" onClick={e => e.stopPropagation()}>
                      <Select value={tx.nature_confirmee} onValueChange={v => updateTx(idx, { nature_confirmee: v, valide: false })}>
                        <SelectTrigger className="h-7 text-xs border-0 bg-transparent p-0 focus:ring-0 shadow-none">
                          <div className="flex items-center gap-1 overflow-hidden">
                            <span className={`text-xs ${confColor(tx.confiance)}`}>●</span>
                            <span className="truncate">{getNatureLabel(tx.nature_confirmee)}</span>
                          </div>
                        </SelectTrigger>
                        <SelectContent>
                          {tx.suggestions.length > 0 && (
                            <>
                              <div className="px-2 py-1 text-xs text-muted-foreground font-semibold">Suggestions IA</div>
                              {tx.suggestions.map((s, si) => (
                                <SelectItem key={si} value={s.nature} className="text-xs">
                                  <span className="text-primary mr-1">{s.confiance}%</span> {getNatureLabel(s.nature)}
                                </SelectItem>
                              ))}
                              <div className="border-t my-1" />
                            </>
                          )}
                          {NATURES_OPERATION.map(n => (
                            <SelectItem key={n.value} value={n.value} className="text-xs">{n.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {tx.alerte && <p className="text-[10px] text-orange-600 truncate">⚠️ {tx.alerte}</p>}
                      {tx.necessite_remarque && <p className="text-[10px] text-blue-600 truncate">💬 {tx.message_pour_comptable}</p>}
                    </div>

                    {/* Document référence */}
                    <div className="col-span-2" onClick={e => e.stopPropagation()}>
                      <Input value={tx.document_reference} onChange={e => updateTx(idx, { document_reference: e.target.value })} placeholder="N° facture / contrat…" className="h-7 text-xs border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none" />
                    </div>

                    {/* Débiteur/Créditeur */}
                    <div className="col-span-2" onClick={e => e.stopPropagation()}>
                      <Input value={tx.debiteur_crediteur} onChange={e => updateTx(idx, { debiteur_crediteur: e.target.value })} placeholder="Client / Fournisseur…" className="h-7 text-xs border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none" />
                    </div>

                    {/* Code PCM */}
                    <div className="col-span-1" onClick={e => e.stopPropagation()}>
                      <Input value={tx.code_comptable} onChange={e => updateTx(idx, { code_comptable: e.target.value })} className="h-7 text-xs font-mono border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none" />
                    </div>

                    {/* HT */}
                    <div className="col-span-1 text-right text-xs font-mono">
                      {tx.montant_ht != null ? tx.montant_ht.toLocaleString("fr-MA", { minimumFractionDigits: 2 }) : "—"}
                    </div>

                    {/* TVA */}
                    <div className="col-span-1 text-right text-xs font-mono text-muted-foreground">
                      {tx.montant_tva != null ? tx.montant_tva.toLocaleString("fr-MA", { minimumFractionDigits: 2 }) : "—"}
                    </div>

                    {/* TTC */}
                    <div className={`col-span-1 text-right text-xs font-mono font-semibold ${tx.montant_credit ? "text-green-600" : "text-red-600"}`}>
                      {tx.montant_credit
                        ? `+${tx.montant_credit.toLocaleString("fr-MA", { minimumFractionDigits: 2 })}`
                        : tx.montant_debit
                        ? `-${tx.montant_debit.toLocaleString("fr-MA", { minimumFractionDigits: 2 })}`
                        : "—"}
                    </div>
                  </div>

                  {/* Libellé original */}
                  <div className="mt-0.5 text-[10px] text-muted-foreground pl-6 truncate">{tx.nature_operation}</div>

                  {/* Panneau détail */}
                  {selectedTx === idx && (
                    <div className="mt-3 ml-6 p-3 rounded-lg bg-muted/50 border space-y-3" onClick={e => e.stopPropagation()}>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Taux TVA</p>
                          <Select value={String(tx.taux_tva)} onValueChange={v => updateTx(idx, { taux_tva: Number(v) })}>
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {[0, 7, 10, 14, 20].map(t => <SelectItem key={t} value={String(t)}>{t}%</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Montant HT</p>
                          <Input type="number" value={tx.montant_ht ?? ""} onChange={e => { const ht = parseFloat(e.target.value) || 0; updateTx(idx, { montant_ht: ht, montant_tva: Math.round(((tx.montant_debit ?? tx.montant_credit ?? 0) - ht) * 100) / 100 }); }} className="h-7 text-xs font-mono" />
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">TVA</p>
                          <Input type="number" value={tx.montant_tva ?? ""} onChange={e => updateTx(idx, { montant_tva: parseFloat(e.target.value) || 0 })} className="h-7 text-xs font-mono" />
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Remarque</p>
                        <Input value={tx.remarque} onChange={e => updateTx(idx, { remarque: e.target.value })} placeholder="Précision sur cette transaction…" className="h-7 text-xs" />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" className="h-7 text-xs" onClick={() => updateTx(idx, { valide: true })}>
                          <CheckCircle className="h-3 w-3 mr-1" />Valider
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateTx(idx, { valide: false })}>
                          Invalider
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Totaux */}
            <div className="sticky bottom-0 bg-card border-t px-4 py-2 grid grid-cols-12 gap-1 text-xs font-semibold shrink-0">
              <div className="col-span-9">TOTAUX</div>
              <div className="col-span-1 text-right">
                {transactions.reduce((s, t) => s + (t.montant_ht ?? (t.montant_debit ?? t.montant_credit ?? 0)), 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })}
              </div>
              <div className="col-span-1 text-right text-muted-foreground">
                {transactions.reduce((s, t) => s + (t.montant_tva ?? 0), 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })}
              </div>
              <div className="col-span-1 text-right">
                <span className="text-green-600">+{transactions.reduce((s, t) => s + (t.montant_credit ?? 0), 0).toLocaleString("fr-MA", { minimumFractionDigits: 0 })}</span>
                {" / "}
                <span className="text-red-600">-{transactions.reduce((s, t) => s + (t.montant_debit ?? 0), 0).toLocaleString("fr-MA", { minimumFractionDigits: 0 })}</span>
              </div>
            </div>
          </div>

          {/* Droite : PDF viewer */}
          <div className="w-96 bg-muted/20 flex flex-col shrink-0">
            <div className="p-3 border-b bg-card shrink-0">
              <p className="text-xs font-semibold">Relevé bancaire original</p>
              {infoReleve && (
                <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                  <p>{infoReleve.banque}</p>
                  {infoReleve.rib && <p>RIB : {infoReleve.rib}</p>}
                  <p>Solde initial : <span className="font-mono">{infoReleve.solde_initial.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD</span></p>
                  <p>Solde final : <span className="font-mono">{infoReleve.solde_final.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD</span></p>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              {pdfUrl && <iframe src={pdfUrl} className="w-full h-full border-0" title="Relevé bancaire" />}
            </div>
          </div>
        </div>
      )}

      {/* Done */}
      {step === "done" && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Écriture comptable validée</h2>
            <p className="text-muted-foreground mb-6">{transactions.filter(t => t.valide).length} transactions enregistrées</p>
            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={genererBilan}><Download className="h-4 w-4 mr-2" />Bilan Sage</Button>
              <Button variant="outline" onClick={genererEDI}><Download className="h-4 w-4 mr-2" />EDI DGI</Button>
              <Button onClick={resetAll}>Nouveau relevé</Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal rescanner */}
      <Dialog open={showRemarques} onOpenChange={setShowRemarques}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Rescanner avec remarques</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Ajoutez des précisions pour améliorer la détection :</p>
            <Textarea
              value={remarques}
              onChange={e => setRemarques(e.target.value)}
              placeholder="Ex : FIRSTAUM = loyer bureau, CNSS chaque 10 du mois, ATLAS = fournisseur emballage…"
              rows={4}
              className="text-sm"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRemarques(false)}>Annuler</Button>
            <Button onClick={() => { setShowRemarques(false); if (pdfFile) lancerScan(pdfFile, remarques); }}>
              <Sparkles className="h-4 w-4 mr-2" />Rescanner avec IA
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


