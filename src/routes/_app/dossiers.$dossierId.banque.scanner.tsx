import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, CheckCircle, X, RefreshCw, Eye, Download, AlertCircle, ChevronDown, FileText, Search, Sparkles } from "lucide-react";
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
  // Catégorisation
  nature_suggeree: string;
  nature_confirmee: string;
  document_reference: string;
  document_reference_id: string | null;
  debiteur_crediteur: string;
  debiteur_crediteur_id: string | null;
  type_tiers: "client" | "fournisseur" | "employe" | "etat" | "banque" | "autre";
  code_comptable: string;
  montant_ht: number | null;
  montant_tva: number | null;
  taux_tva: number;
  confiance: number;
  valide: boolean;
  remarque: string;
  alerte: string | null;
  // Suggestions IA
  suggestions: Array<{
    nature: string;
    code_comptable: string;
    document: string;
    tiers: string;
    confiance: number;
  }>;
}

interface InfoReleve {
  banque: string;
  titulaire: string;
  rib: string;
  periode: string;
  solde_initial: number;
  solde_final: number;
}

// ── PCM Marocain ──────────────────────────────────────────────────────────────
const NATURES_OPERATION = [
  { value: "encaissement_client",    label: "Encaissement client",       code: "3421", tva: false },
  { value: "paiement_fournisseur",   label: "Paiement fournisseur",      code: "4411", tva: true  },
  { value: "salaires",               label: "Paiement salaires",         code: "4432", tva: false },
  { value: "cnss_amo",               label: "CNSS / AMO",                code: "6174", tva: false },
  { value: "tva_dgi",                label: "TVA / Impôts DGI",          code: "4456", tva: false },
  { value: "loyers",                 label: "Loyer / Location",          code: "6131", tva: false  },
  { value: "eau_electricite",        label: "Eau / Électricité ONEE",    code: "61251", tva: true  },
  { value: "telecom",                label: "Téléphone / Internet",      code: "6145", tva: true  },
  { value: "gasoil",                 label: "Gasoil / Carburant",        code: "6122", tva: true  },
  { value: "assurance",              label: "Assurance",                 code: "6161", tva: false },
  { value: "entretien",              label: "Entretien / Réparation",    code: "6133", tva: true  },
  { value: "fournitures_bureau",     label: "Fournitures bureau",        code: "61227", tva: true  },
  { value: "frais_bancaires",        label: "Frais bancaires",           code: "6147", tva: true },
  { value: "taxe_professionnelle",   label: "Taxe Professionnelle",      code: "6313", tva: false },
  { value: "retrait_especes",        label: "Retrait espèces / GAB",     code: "5161", tva: false },
  { value: "interets_crediteurs",    label: "Intérêts créditeurs",       code: "7611", tva: false },
  { value: "virement_interne",       label: "Virement interne",          code: "5141", tva: false },
  { value: "autre",                  label: "Autre opération",           code: "6141", tva: false },
];

// ── Server function : Groq analyse ────────────────────────────────────────────
export const analyserTransactions = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    dossier_id: z.string().uuid(),
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

    const prompt = `Tu es un Expert-Comptable Marocain certifié et un auditeur fiscal spécialisé dans le Plan Comptable Marocain (PCM / CGNC). Ton rôle est d'analyser des transactions bancaires, de les catégoriser, et de détecter toute anomalie fiscale ou comptable.

---
DONNÉES DE RÉFÉRENCE:
1. Factures clients (TVA en attente/encaissement): ${JSON.stringify(data.factures_client.map((f: any) => ({ num: f.numero, client: f.clients?.nom, ttc: f.montant_ttc, ht: f.montant_ht, tva: f.montant_tva, date: f.date })))}
2. Factures fournisseurs (à payer): ${JSON.stringify(data.factures_fourn.map((f: any) => ({ num: f.numero, fourn: f.fournisseur_nom, ttc: f.montant_ttc, ht: f.montant_ht, tva: f.montant_tva, date: f.date })))}
3. Référentiel Tiers: ${JSON.stringify([...data.fournisseurs, ...data.clients].map((t: any) => ({ nom: t.nom, ice: t.ice })))}
${data.remarques ? `Notes spécifiques du dossier: ${data.remarques}` : ""}

---
TRANSACTIONS BANCAIRES À AUDITER:
${JSON.stringify(data.transactions_brutes.map((tx: any) => ({
  ligne: tx.ligne,
  date: tx.date_operation,
  libelle: tx.nature_operation,
  debit: tx.montant_debit,
  credit: tx.montant_credit,
})))}

---
INSTRUCTIONS DE CLASSIFICATION ET D'AUDIT:

1. ANALYSE DE LA TVA (RÈGLES MAROC):
- Loyers (6131): TVA 20% (si assujetti). [cite: 15]
- Électricité (61251): TVA 14%. [cite: 1]
- Eau (61251): TVA 7%. [cite: 1]
- Télécom / Internet (6145): TVA 20%. [cite: 15]
- Frais Bancaires (6147): TVA 10% (obligatoire). [cite: 15]
- Gasoil (61222): TVA 10% (Récupérable uniquement si éligible). [cite: 15]
- Transports (6142): TVA 14%. [cite: 15]

2. RÈGLES DE MATCHING (AUDIT NIVEAU 3):
- Pour chaque encaissement (CRÉDIT), cherche une correspondance avec "Factures clients".
- Si le montant TTC de la facture != montant encaissé, calcule l'écart et signale un "Paiement partiel" ou "Écart de règlement" dans 'alerte'.
- Vérifie si le libellé bancaire contient des mots-clés des "Référentiels Tiers".

3. DÉTECTION D'ANOMALIES:
- Alerte si une transaction de type 'frais_bancaires' n'a pas de TVA calculée à 10%.
- Alerte si un virement tiers est identifié mais qu'aucune facture n'existe dans les données de référence.

---
FORMAT DE RÉPONSE (JSON UNIQUEMENT):
{
  "analyses": [
    {
      "ligne": number,
      "nature_principale": "encaissement_client|paiement_fournisseur|salaires|cnss_amo|tva_dgi|loyers|eau_electricite|telecom|gasoil|assurance|entretien|fournitures_bureau|frais_bancaires|taxe_professionnelle|retrait_especes|interets_crediteurs|virement_interne|autre",
      "code_pcm": "string (4 chiffres)",
      "tiers_nom": "string|null",
      "tiers_type": "client|fournisseur|employe|etat|banque|autre",
      "facture_num": "string|null",
      "montant_ht": number|null,
      "montant_tva": number|null,
      "taux_tva": 0|7|10|14|20,
      "confiance": number (0-100),
      "alerte": "string|null (Ex: 'Écart de 200 DH avec facture', 'TVA 10% non appliquée')",
      "suggestions": [{"nature":"string", "code_pcm":"string", "confiance":number}]
    }
  ]
}`;

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
      const err = await res.json() as any;
      throw new Error(`Groq: ${err.error?.message}`);
    }

    const groqData = await res.json() as any;
    let content = groqData.choices[0].message.content as string;
    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(content) as { analyses: any[] };
  });

// ── Composant principal ───────────────────────────────────────────────────────
function RelEveScanner() {
  const { dossierId } = Route.useParams();

  // États principaux
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
  const [compte, setCompte] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLDivElement>(null);

  // Charger les données du dossier
  useEffect(() => {
    Promise.all([
      supabase.from("factures").select("id,numero,montant_ht,montant_ttc,montant_tva,clients(id,nom,ice)").eq("dossier_id", dossierId).eq("statut","conforme").neq("statut_paiement","payee"),
      (supabase as any).from("factures_fournisseurs").select("id,numero,montant_ht,montant_ttc,montant_tva,fournisseur_nom,fournisseur_id").eq("dossier_id", dossierId).neq("statut_paiement","payee"),
      (supabase as any).from("fournisseurs").select("id,nom,ice").eq("dossier_id", dossierId),
      supabase.from("clients").select("id,nom,ice").eq("dossier_id", dossierId),
    ]).then(([{ data: f }, { data: ff }, { data: fo }, { data: cl }]) => {
      setFactures(f ?? []);
      setFacturesFourn(ff ?? []);
      setFournisseurs(fo ?? []);
      setClients(cl ?? []);
    });
  }, [dossierId]);

  // Upload du relevé
  const handleUpload = async (file: File) => {
    setPdfFile(file);
    const url = URL.createObjectURL(file);
    setPdfUrl(url);
    setStep("scan");
    await lancerScan(file);
  };

  const lancerScan = async (file: File, remarquesExtra = "") => {
    setScanning(true);
    try {
      // Extraction texte PDF côté client via pdfjs
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

      // Parser les transactions (logique extraite du parseur BP)
      const txBrutes = parserTransactionsBP(fullText);
      const infoBrute = parserInfoReleve(fullText);
      setInfoReleve(infoBrute);

      // Envoyer à Groq pour catégorisation
      const result = await analyserTransactions({
        data: {
          dossier_id: dossierId,
          transactions_brutes: txBrutes,
          factures_client: factures,
          factures_fourn: facturesFourn,
          fournisseurs,
          clients,
          remarques: remarquesExtra || remarques,
        }
      });

      // Fusionner résultats
      const txFinal: Transaction[] = txBrutes.map((tx: any, idx: number) => {
        const analyse = result.analyses.find((a: any) => a.ligne === tx.ligne) || result.analyses[idx] || {};
        const nature = NATURES_OPERATION.find(n => n.value === analyse.nature_principale);
        return {
          id: `tx_${idx}`,
          ligne: tx.ligne,
          date_operation: tx.date_operation,
          date_valeur: tx.date_valeur,
          reference: tx.reference || "",
          nature_operation: tx.nature_operation,
          montant_debit: tx.montant_debit,
          montant_credit: tx.montant_credit,
          nature_suggeree: analyse.nature_principale || "autre",
          nature_confirmee: analyse.nature_principale || "autre",
          document_reference: analyse.facture_num || "",
          document_reference_id: null,
          debiteur_crediteur: analyse.tiers_nom || "",
          debiteur_crediteur_id: null,
          type_tiers: analyse.tiers_type || "autre",
          code_comptable: analyse.code_pcm || nature?.code || "6141",
          montant_ht: analyse.montant_ht || null,
          montant_tva: analyse.montant_tva || null,
          taux_tva: analyse.taux_tva || 0,
          confiance: analyse.confiance || 50,
          valide: (analyse.confiance || 0) >= 90,
          remarque: "",
          alerte: analyse.alerte || null,
          suggestions: analyse.suggestions || [],
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

  // Parser simplifié côté client (logique BP adaptée)
  const parserTransactionsBP = (text: string): any[] => {
    const txs: any[] = [];
    const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 3);
    const EXCL = ['solde a reporter','ancien solde','total des','banque populaire','agence','adresse','extrait de compte','releve d','code banque','date oper','montant','page n','www.','sa au capital','denomination'];
    const BP_DATE = /^(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{2})\s+(\d{2})\s+(\d{4})\s+/;
    const CIH_DATE = /^(\d{2})[\/\-](\d{2})\d?\s+\d?\s*\d{0,2}[\/\-]\d{2}/;
    const ATTIJARI_DATE = /^([0-9A-Z]{5,7})\s+(\d{2}\s+\d{2})\s+/;
    const AMOUNT = /\b(\d{1,3}(?:\s\d{3})*,\d{2})\b/g;
    const AMOUNT2 = /(?<![,\d])(\d{2,7}),(\d{2})(?!\d)/g;
    const year = new Date().getFullYear();
    let merged: string[] = [];

    for (const line of lines) {
      const low = line.toLowerCase();
      if (EXCL.some(e => low.includes(e))) continue;
      if (/^[\u0600-\u06FF\s,\.]+$/.test(line)) continue;
      const hasBP = BP_DATE.test(line);
      const hasCIH = CIH_DATE.test(line);
      const hasATT = ATTIJARI_DATE.test(line);
      if (hasBP || hasCIH || hasATT) {
        merged.push(line);
      } else if (merged.length > 0) {
        if (/^[\d]+$/.test(line.trim()) || /^,\d+/.test(line.trim())) merged[merged.length-1] += line.trim();
        else merged[merged.length-1] += " " + line;
      }
    }

    let ligne = 1;
    for (const line of merged) {
      const fixed = line.replace(/(\d+,\d)\s+(\d)\b/g, '$1$2');
      let amounts = [...fixed.matchAll(/\b(\d{1,3}(?:\s\d{3})*),(\d{2})\b/g)].map(m => parseFloat(m[1].replace(/\s/g,'') + '.' + m[2]));
      if (!amounts.length) amounts = [...fixed.matchAll(/(?<![,\d])(\d{2,7}),(\d{2})(?!\d)/g)].map(m => parseFloat(m[1]+'.'+m[2]));
      if (!amounts.length || amounts[amounts.length-1] <= 0) continue;
      const montant = amounts[amounts.length-1];
      const up = line.toUpperCase();
      const isCredit = up.includes('RECU') || up.includes('REMISE CHEQUE') || up.includes('VERSEMENT ESPECE') || up.includes('INTERETS CREDIT') || up.includes('VIRT RECU') || up.includes('RECU DE');
      let date = "";
      const bp = line.match(/^(\d{2})\s+(\d{2})\s+(\d{4})/);
      const cih = line.match(/^(\d{2})[\/\-](\d{2})/);
      const att = line.match(/^[0-9A-Z]{5,7}\s+(\d{2})\s+(\d{2})/);
      if (bp) date = `${bp[1]}/${bp[2]}/${bp[3]}`;
      else if (cih) date = `${cih[1]}/${cih[2]}/${year}`;
      else if (att) date = `${att[1]}/${att[2]}/${year}`;
      if (!date) continue;
      let libelle = fixed.replace(/^\d{2}[\/\-]?\d{2}[\/\-]?\d{0,4}\s+\d{0,2}[\/\-]?\d{0,2}[\/\-]?\d{0,4}\s+/,'').replace(/^[0-9A-Z]{5,7}\s+\d{2}\s+\d{2}\s+/,'');
      libelle = libelle.replace(/\b\d{1,3}(?:\s\d{3})*,\d{2}\b/g,'').replace(/(?<![,\d])\d{2,7},\d{2}(?!\d)/g,'').replace(/\s{2,}/g,' ').trim().slice(0,100);
      txs.push({ ligne: ligne++, date_operation: date, date_valeur: date, reference: "", nature_operation: libelle || "Transaction", montant_debit: isCredit ? null : montant, montant_credit: isCredit ? montant : null });
    }
    return txs;
  };

  const parserInfoReleve = (text: string): InfoReleve => {
    const banque = text.toLowerCase().includes('attijariwafa') ? 'Attijariwafa Bank' : text.toLowerCase().includes('banque populaire') ? 'Banque Populaire' : text.toLowerCase().includes('cih') ? 'CIH Bank' : 'Banque';
    const mRib = text.match(/(\d{3})\s+(\d{3})\s+([\d\s]+)\s+(\d{2})/);
    const mSoldeInit = text.match(/(?:SOLDE DEPART|ANCIEN SOLDE)[\s\S]*?([\d\s]+,\d{2})/i);
    const mSoldeFin = text.match(/(?:SOLDE A REPORTER|NOUVEAU SOLDE)[\s\S]{0,50}([\d\s]+,\d{2})/i);
    const parseMontant = (s: string | undefined) => s ? parseFloat(s.replace(/\s/g,'').replace(',','.')) : 0;
    return {
      banque,
      titulaire: "",
      rib: mRib ? `${mRib[1]} ${mRib[2]} ${mRib[3].trim()} ${mRib[4]}` : "",
      periode: "",
      solde_initial: parseMontant(mSoldeInit?.[1]),
      solde_final: parseMontant(mSoldeFin?.[1]),
    };
  };

  const updateTx = (idx: number, updates: Partial<Transaction>) => {
    setTransactions(prev => prev.map((tx, i) => {
      if (i !== idx) return tx;
      const updated = { ...tx, ...updates };
      // Recalculer HT/TVA si nature change
      if (updates.nature_confirmee) {
        const nature = NATURES_OPERATION.find(n => n.value === updates.nature_confirmee);
        if (nature) {
          updated.code_comptable = nature.code;
          const montant = tx.montant_debit ?? tx.montant_credit ?? 0;
          if (nature.tva && montant > 0) {
            const taux = updated.taux_tva || 20;
            updated.montant_ht = Math.round(montant / (1 + taux/100) * 100) / 100;
            updated.montant_tva = Math.round((montant - updated.montant_ht) * 100) / 100;
          } else {
            updated.montant_ht = montant;
            updated.montant_tva = null;
          }
        }
      }
      return updated;
    }));
  };

  const validerToutes = () => {
    setTransactions(prev => prev.map(tx => ({ ...tx, valide: true })));
    toast.success("Toutes les transactions validées");
  };

  // Valider et enregistrer les écritures
  const handleValider = async () => {
    const nonValidees = transactions.filter(tx => !tx.valide);
    if (nonValidees.length > 0) {
      const conf = window.confirm(`${nonValidees.length} transaction(s) non validées. Continuer quand même ?`);
      if (!conf) return;
    }
    setSaving(true);
    try {
      const ecritures: any[] = [];
      const txValides = transactions.filter(tx => tx.valide);
      for (const tx of txValides) {
        const date = tx.date_operation.includes('/') ? tx.date_operation.split('/').reverse().join('-') : tx.date_operation;
        const montant = tx.montant_credit ?? tx.montant_debit ?? 0;
        const libelle = tx.debiteur_crediteur ? `${tx.nature_operation} - ${tx.debiteur_crediteur}` : tx.nature_operation;
        // Écriture banque (5141)
        ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: "5141", date_ecriture: date, libelle: libelle.slice(0,100), debit: tx.montant_credit ? montant : 0, credit: tx.montant_debit ? montant : 0, reference_piece: tx.document_reference || tx.reference, valide: true });
        // Contre-écriture
        const ht = tx.montant_ht ?? montant;
        const tva = tx.montant_tva ?? 0;
        if (tva > 0 && tx.montant_debit) {
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: tx.code_comptable, date_ecriture: date, libelle: libelle.slice(0,100), debit: ht, credit: 0, reference_piece: tx.document_reference, valide: true });
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: "34552", date_ecriture: date, libelle: `TVA récup. ${libelle.slice(0,50)}`, debit: tva, credit: 0, reference_piece: tx.document_reference, valide: true });
        } else {
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: tx.code_comptable, date_ecriture: date, libelle: libelle.slice(0,100), debit: tx.montant_debit ? 0 : ht, credit: tx.montant_credit ? 0 : ht, reference_piece: tx.document_reference, valide: true });
        }
      }
      await supabase.from("ecritures_comptables").insert(ecritures);
      toast.success(`${txValides.length} transactions comptabilisées — ${ecritures.length} écritures créées`);
      setStep("done");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Génération fichier EDI DGI
  const genererEDI = () => {
    const txFourn = transactions.filter(tx => tx.valide && tx.nature_confirmee === "paiement_fournisseur" && tx.montant_debit);
    if (!txFourn.length) { toast.warning("Aucune transaction fournisseur validée pour l'EDI"); return; }
    const rows = [["OR","FACT_NUM","DESIGNATION","M_HT","TVA","M_TTC","IF","LIB_FRSS","ICE_FRS","TAUX","ID_PAIE","DATE_PAIE","DATE_FAC"]];
    txFourn.forEach((tx, i) => {
      const fourn = fournisseurs.find(f => f.nom === tx.debiteur_crediteur) as any;
      rows.push([
        String(i+1), tx.document_reference || "—", tx.nature_operation.slice(0,50),
        String(tx.montant_ht ?? tx.montant_debit ?? 0),
        String(tx.montant_tva ?? 0),
        String(tx.montant_debit ?? 0),
        fourn?.if || "",
        tx.debiteur_crediteur || "FOURNISSEUR",
        fourn?.ice || "",
        String(tx.taux_tva || 20),
        String(i+1),
        tx.date_operation,
        tx.date_valeur,
      ]);
    });
    const csv = rows.map(r => r.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `EDI_DGI_TVA_${new Date().toISOString().slice(0,7)}.csv`; a.click();
    toast.success("Fichier EDI DGI généré");
  };

  const genererBilan = () => {
    const rows = [["Date","Journal","Compte","Libellé","Débit","Crédit","Réf. facture"]];
    transactions.filter(tx => tx.valide).forEach(tx => {
      const montant = tx.montant_credit ?? tx.montant_debit ?? 0;
      const libelle = `${tx.nature_operation} - ${tx.debiteur_crediteur}`;
      rows.push([tx.date_operation, "BQ", "5141", libelle, tx.montant_credit ? String(montant) : "", tx.montant_debit ? String(montant) : "", tx.document_reference]);
      const ht = tx.montant_ht ?? montant;
      const tva = tx.montant_tva ?? 0;
      if (tva > 0 && tx.montant_debit) {
        rows.push([tx.date_operation, "BQ", tx.code_comptable, libelle, String(ht), "", tx.document_reference]);
        rows.push([tx.date_operation, "BQ", "34552", `TVA ${libelle}`, String(tva), "", tx.document_reference]);
      } else {
        rows.push([tx.date_operation, "BQ", tx.code_comptable, libelle, tx.montant_debit ? "" : String(ht), tx.montant_credit ? "" : String(ht), tx.document_reference]);
      }
    });
    const csv = rows.map(r => r.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `Bilan_SAGE_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    toast.success("Fichier bilan Sage généré");
  };

  const getNatureLabel = (value: string) => NATURES_OPERATION.find(n => n.value === value)?.label || value;
  const getConfianceColor = (c: number) => c >= 90 ? "text-green-600" : c >= 70 ? "text-yellow-600" : "text-red-500";
  const getConfianceBg = (c: number) => c >= 90 ? "bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-800" : c >= 70 ? "bg-yellow-50 border-yellow-200 dark:bg-yellow-950/20" : "bg-red-50 border-red-200 dark:bg-red-950/20";
  const nbValides = transactions.filter(t => t.valide).length;
  const nbAlertes = transactions.filter(t => t.alerte).length;

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* ── Header ── */}
      <div className="border-b px-6 py-3 flex items-center justify-between bg-card shrink-0">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-primary" />
          <div>
            <h1 className="font-bold text-base">Scanner de relevé bancaire</h1>
            {infoReleve && <p className="text-xs text-muted-foreground">{infoReleve.banque} — {infoReleve.rib}</p>}
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
            <Button variant="outline" size="sm" onClick={validerToutes}>
              <CheckCircle className="h-3.5 w-3.5 mr-1.5" />Valider tout
            </Button>
            <Button size="sm" onClick={handleValider} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5 mr-1.5" />}
              Valider écriture
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setStep("upload"); setPdfUrl(null); setTransactions([]); }}>
              <X className="h-3.5 w-3.5 mr-1.5" />Annuler
            </Button>
          </div>
        )}
      </div>

      {/* ── Corps ── */}
      {step === "upload" && (
        <div className="flex-1 flex items-center justify-center">
          <div
            className="border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer hover:border-primary transition-all max-w-lg w-full mx-4"
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleUpload(f); }}>
            <input ref={fileRef} type="file" className="hidden" accept=".pdf" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <p className="font-semibold text-lg mb-1">Importez votre relevé bancaire</p>
            <p className="text-sm text-muted-foreground mb-4">PDF — CIH, Attijariwafa, Banque Populaire, BMCI</p>
            <Button>Sélectionner le fichier PDF</Button>
          </div>
        </div>
      )}

      {step === "scan" && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary mb-4" />
            <p className="font-semibold text-lg">Analyse en cours…</p>
            <p className="text-sm text-muted-foreground mt-1">Extraction des transactions + Classification IA</p>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="flex-1 flex overflow-hidden">
          {/* ── Partie gauche : transactions ── */}
          <div className="flex-1 overflow-y-auto border-r">
            {/* En-tête colonnes */}
            <div className="sticky top-0 bg-muted/80 backdrop-blur border-b px-4 py-2 grid grid-cols-12 gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide z-10">
              <div className="col-span-1">#</div>
              <div className="col-span-1">Date</div>
              <div className="col-span-2">Nature opération</div>
              <div className="col-span-2">Doc. référence</div>
              <div className="col-span-2">Débiteur/Créditeur</div>
              <div className="col-span-1">Code PCM</div>
              <div className="col-span-1 text-right">HT</div>
              <div className="col-span-1 text-right">TVA</div>
              <div className="col-span-1 text-right">TTC</div>
            </div>

            {transactions.map((tx, idx) => (
              <div
                key={tx.id}
                className={`border-b px-4 py-2 cursor-pointer transition-colors ${selectedTx === idx ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/30"} ${tx.valide ? "" : "opacity-75"}`}
                onClick={() => setSelectedTx(selectedTx === idx ? null : idx)}>
                {/* Ligne principale */}
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
                  <div className="col-span-2">
                    <Select value={tx.nature_confirmee} onValueChange={v => updateTx(idx, { nature_confirmee: v, valide: false })}>
                      <SelectTrigger className="h-7 text-xs border-0 bg-transparent p-0 focus:ring-0 shadow-none">
                        <div className="flex items-center gap-1 overflow-hidden">
                          <span className={`text-xs ${getConfianceColor(tx.confiance)}`}>●</span>
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
                    {tx.alerte && <p className="text-[10px] text-orange-600 truncate">{tx.alerte}</p>}
                  </div>

                  {/* Document référence */}
                  <div className="col-span-2">
                    <Input
                      value={tx.document_reference}
                      onChange={e => updateTx(idx, { document_reference: e.target.value })}
                      placeholder="N° facture / contrat…"
                      className="h-7 text-xs border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none"
                    />
                  </div>

                  {/* Débiteur/Créditeur */}
                  <div className="col-span-2">
                    <Input
                      value={tx.debiteur_crediteur}
                      onChange={e => updateTx(idx, { debiteur_crediteur: e.target.value })}
                      placeholder="Client / Fournisseur…"
                      className="h-7 text-xs border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none"
                    />
                  </div>

                  {/* Code PCM */}
                  <div className="col-span-1">
                    <Input
                      value={tx.code_comptable}
                      onChange={e => updateTx(idx, { code_comptable: e.target.value })}
                      className="h-7 text-xs font-mono border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none"
                    />
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

                {/* Panneau détail étendu */}
                {selectedTx === idx && (
                  <div className="mt-3 ml-6 p-3 rounded-lg bg-muted/50 border space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Taux TVA</p>
                        <Select value={String(tx.taux_tva)} onValueChange={v => updateTx(idx, { taux_tva: Number(v) })}>
                          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {[0,7,10,14,20].map(t => <SelectItem key={t} value={String(t)}>{t}%</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Montant HT</p>
                        <Input type="number" value={tx.montant_ht ?? ""} onChange={e => { const ht = parseFloat(e.target.value)||0; const tva = Math.round((tx.montant_debit??tx.montant_credit??0)-ht); updateTx(idx, { montant_ht: ht, montant_tva: tva }); }} className="h-7 text-xs font-mono" placeholder="HT" />
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">TVA</p>
                        <Input type="number" value={tx.montant_tva ?? ""} onChange={e => updateTx(idx, { montant_tva: parseFloat(e.target.value)||0 })} className="h-7 text-xs font-mono" placeholder="TVA" />
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Remarque</p>
                      <Input value={tx.remarque} onChange={e => updateTx(idx, { remarque: e.target.value })} placeholder="Remarque ou précision sur cette transaction…" className="h-7 text-xs" />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" className="h-7 text-xs" onClick={() => updateTx(idx, { valide: true })}>
                        <CheckCircle className="h-3 w-3 mr-1" />Valider cette ligne
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateTx(idx, { valide: false })}>
                        Invalider
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Totaux */}
            <div className="sticky bottom-0 bg-card border-t px-4 py-2 grid grid-cols-12 gap-1 text-xs font-semibold">
              <div className="col-span-9">TOTAUX</div>
              <div className="col-span-1 text-right">{transactions.reduce((s,t) => s + (t.montant_ht ?? (t.montant_debit ?? t.montant_credit ?? 0)), 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })}</div>
              <div className="col-span-1 text-right text-muted-foreground">{transactions.reduce((s,t) => s + (t.montant_tva ?? 0), 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })}</div>
              <div className="col-span-1 text-right">
                <span className="text-green-600">+{transactions.reduce((s,t) => s + (t.montant_credit ?? 0), 0).toLocaleString("fr-MA", { minimumFractionDigits: 0 })}</span>
                {" / "}
                <span className="text-red-600">-{transactions.reduce((s,t) => s + (t.montant_debit ?? 0), 0).toLocaleString("fr-MA", { minimumFractionDigits: 0 })}</span>
              </div>
            </div>
          </div>

          {/* ── Partie droite : PDF viewer ── */}
          <div className="w-96 bg-muted/20 flex flex-col shrink-0">
            <div className="p-3 border-b bg-card">
              <p className="text-xs font-semibold">Relevé bancaire</p>
              {infoReleve && (
                <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                  <p>{infoReleve.banque}</p>
                  {infoReleve.rib && <p>RIB: {infoReleve.rib}</p>}
                  <p>Solde initial: <span className="font-mono">{infoReleve.solde_initial.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD</span></p>
                  <p>Solde final: <span className="font-mono">{infoReleve.solde_final.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD</span></p>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              {pdfUrl && (
                <iframe src={pdfUrl} className="w-full h-full border-0" title="Relevé bancaire" />
              )}
            </div>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Écriture comptable validée</h2>
            <p className="text-muted-foreground mb-6">{transactions.filter(t=>t.valide).length} transactions enregistrées dans la comptabilité</p>
            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={genererBilan}><Download className="h-4 w-4 mr-2" />Télécharger bilan Sage</Button>
              <Button variant="outline" onClick={genererEDI}><Download className="h-4 w-4 mr-2" />Télécharger EDI DGI</Button>
              <Button onClick={() => { setStep("upload"); setPdfUrl(null); setTransactions([]); setInfoReleve(null); }}>Nouveau relevé</Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal rescanner avec remarques */}
      <Dialog open={showRemarques} onOpenChange={setShowRemarques}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Rescanner avec remarques</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Ajoutez des précisions pour améliorer la détection automatique :</p>
            <Textarea
              value={remarques}
              onChange={e => setRemarques(e.target.value)}
              placeholder="Ex: FIRSTAUM = loyer bureau. CNSS le 10 de chaque mois. Société ATLAS = fournisseur emballage…"
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
