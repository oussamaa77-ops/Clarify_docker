import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Landmark, Upload, Loader2, TrendingUp, TrendingDown, CheckCircle, FileText, AlertCircle, RefreshCw, Download, X, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/_app/dossiers/$dossierId/banque")({
  component: BanquePage,
});

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Compte { id: string; banque: string | null; intitule: string | null; rib: string | null; solde_actuel: number; }
interface TxBancaire { id: string; date_operation: string; libelle: string | null; type: string; montant: number; solde_apres: number | null; rapproche: boolean; }
interface Releve { id: string; fichier_nom: string | null; statut: string; nombre_transactions: number; solde_initial: number; solde_final: number; created_at: string; }
interface FactureNonPayee { id: string; type: "client" | "fournisseur"; numero: string | null; nom: string; montant_ttc: number; date_echeance: string | null; }

interface TxExtracted {
  date_operation: string; date_valeur: string; reference: string;
  libelle: string; type: "credit" | "debit"; montant: number;
  categorie: string; compte_comptable: string;
  reference_facture: string | null; confiance: number;
  facture_id: string | null; alerte: string | null;
}

interface InfoReleve { banque: string; rib: string; solde_initial: number; solde_final: number; }

// ─── Server function : analyse Gemini → catégorisation + matching ─────────────
export const analyserReleveIA = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    transactions_brutes: z.array(z.any()),
    factures_client: z.array(z.any()),
    factures_fourn: z.array(z.any()),
    clients: z.array(z.any()),
    fournisseurs: z.array(z.any()),
    dossier_nom: z.string().default(""),
    dossier_ice: z.string().default(""),
    remarques: z.string().optional(),
  }).parse(input))
  .handler(async ({ data }) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey   = process.env.GROQ_API_KEY;

    const prompt = `Tu es expert-comptable marocain certifié (PCM/CGNC). Analyse ces transactions bancaires.

SOCIÉTÉ DU DOSSIER: "${data.dossier_nom}" (ICE: ${data.dossier_ice || "non renseigné"})
CRÉDITS = encaissements. DÉBITS = paiements ou charges.

FACTURES CLIENTS NON ENCAISSÉES:
${JSON.stringify(data.factures_client.map((f: any) => ({ id: f.id, num: f.numero, client: f.clients?.nom, ttc: Number(f.montant_ttc), ht: Number(f.montant_ht), echeance: f.date_echeance })))}

FACTURES FOURNISSEURS NON PAYÉES:
${JSON.stringify(data.factures_fourn.map((f: any) => ({ id: f.id, num: f.numero, fournisseur: f.fournisseur_nom, ttc: Number(f.montant_ttc), ht: Number(f.montant_ht), echeance: f.date_echeance })))}

CLIENTS: ${JSON.stringify(data.clients.map((c: any) => ({ nom: c.nom, ice: c.ice })))}
FOURNISSEURS: ${JSON.stringify(data.fournisseurs.map((f: any) => ({ nom: f.nom, ice: f.ice })))}
${data.remarques ? `REMARQUES (PRIORITÉ ABSOLUE):\n${data.remarques}\n` : ""}

TRANSACTIONS À ANALYSER:
${JSON.stringify(data.transactions_brutes.map((tx: any, i: number) => ({ i, date: tx.date_operation, libelle: tx.libelle, debit: tx.montant_debit, credit: tx.montant_credit })))}

ALGORITHME (ordre strict):
1. REMARQUES COMPTABLE → confiance 100%
2. NUMÉRO FACTURE dans libellé → confiance 95%, retourner facture_id UUID
3. NOM TIERS dans libellé (3+ lettres communes, tolérer abréviations) → confiance 85%
4. MONTANT TTC EXACT ±1 MAD + date ≤ echeance+15j → confiance 80%, retourner facture_id
5. MOTS-CLÉS PCM marocain:
   CNSS|AMO→6174(0%) | TVA|DGI|IR|IS→4456(0%) | SALAIRE→6171(0%)
   IAM|INWI|ORANGE|TELECOM→6132(20%) | LOYER|LOCATION→6131(20%)
   GASOIL|CARBURANT→6122(20%) | EAU|ONEE|AMENAU→6125(7%)
   ASSURANCE→6161(0%) | COMMISSION|FRAIS BANC→6347(10%)
   RETRAIT|GAB|ESPECES→5161(0%) | IMPORT|DOUANE→6146(0%)
   RESTAURANT|LOUNG|CAFE→6147(0%) | ENTRETIEN|REPARATION→6141(20%)
   TRANSPORT|DEPLACEMENT→6145(0%) → confiance 75%
6. DIRECTION: credit→encaissement_client/3421, debit→paiement_fournisseur/4411 → confiance 60%
7. INCONNU → alerte avec message pour comptable

Réponds UNIQUEMENT avec ce JSON:
{"analyses":[{"i":0,"categorie":"encaissement_client|paiement_fournisseur|salaires|cnss_amo|tva_dgi|loyers|eau_electricite|telecom|gasoil|assurance|entretien|frais_bancaires|frais_representation|frais_douane|retrait_especes|interets_crediteurs|autre","code_pcm":"string","tiers_nom":"string|null","facture_num":"string|null","facture_id":"string|null","montant_ht":null,"montant_tva":null,"taux_tva":0,"confiance":0,"alerte":"string|null","necessite_remarque":false}]}`;

    // Tenter Gemini d'abord, fallback Groq
    let content = "";
    if (geminiKey) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
          { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: "application/json", temperature: 0 } }) }
        );
        if (res.ok) {
          const d = await res.json();
          content = d.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          console.log("[RELEVE AI] Gemini OK");
        } else { console.log("[RELEVE AI] Gemini", res.status, "→ fallback Groq"); }
      } catch(e) { console.log("[RELEVE AI] Gemini exception → fallback Groq"); }
    }

    if (!content && groqKey) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0, max_tokens: 4000, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
      });
      if (res.ok) {
        const d = await res.json() as any;
        content = d.choices[0].message.content;
        console.log("[RELEVE AI] Groq OK");
      }
    }

    if (!content) throw new Error("Aucune API IA disponible");
    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(content) as { analyses: any[] };
  });

// ─── Helpers parser (portés de awb_line_to_tx + bp_split_line Python) ─────────
const OCR_FIXES: Record<string, string> = {
  "C0MMISSI0N":"COMMISSION","C0MMISSION":"COMMISSION","COMMISSI0N":"COMMISSION",
  "S0CIETE":"SOCIETE","D0CUMENT":"DOCUMENT","C0MPTE":"COMPTE",
  "M0NETIQUE":"MONETIQUE","CHE0UE":"CHEQUE","CHE0UES":"CHEQUES",
};

function cleanNature(t: string): string {
  if (!t) return "";
  let s = t.toUpperCase().replace(/\s+/g," ").trim();
  for (const [a,b] of Object.entries(OCR_FIXES)) s = s.split(a).join(b);
  s = s.replace(/(?<=[A-Z])0(?=[A-Z])/g,"O");
  return s.trim();
}

function cleanAmount(s: string): number | null {
  if (!s) return null;
  let v = s.replace(/\xa0/g," ").replace(/O/gi,"0").replace(/[^\d,.\s]/g,"");
  v = v.replace(/\s/g,"");
  if (!v) return null;
  if (v.endsWith(",") || v.endsWith(".")) v += "00";
  if (v.includes(",")) v = v.replace(/\./g,"").replace(",",".");
  const n = parseFloat(v);
  return isNaN(n)||n<=0?null:Math.round(n*100)/100;
}

const CREDIT_KW = ["RECU","REÇU","REMISE CHEQUE","REMISE CHQ","VERSEMENT RECU",
  "VIR.WEB RECU","VIR INST RECU","INTERETS CREDIT","AVIS DE CREDIT","DEPOT","CREDIT VIREMENT"];

function looksCredit(n: string): boolean {
  const u = (n||"").toUpperCase();
  return CREDIT_KW.some(k=>u.includes(k));
}

// ATW (adapté de awb_line_to_tx)
function parseATW(line: string, year: number): any|null {
  const raw = line.replace(/@/g,"0").replace(/\s+/g," ").trim();
  const pr = raw.replace(/O/g,"0").replace(/o/g,"0").replace(/\//g," ");
  let m = pr.match(/^([A-Z0-9]{5,7})\s+(\d{2})\s+(\d{2})\s+(.+)$/);
  if (!m) { const m2=pr.match(/^([A-Z0-9]{6})(\d{2})\s+(\d{2})\s+(.+)$/); if(m2) m=[m2[0],m2[1],m2[2],m2[3],m2[4]]; }
  if (!m) return null;
  const [,code,d1,m1,rest]=m;
  const dms=[...rest.matchAll(/(\d{2})\s+(\d{2})\s+(20\d{2})/g)];
  if (!dms.length) return null;
  const dm=dms[dms.length-1];
  const nat=rest.slice(0,dm.index!).trim().replace(/-\s*$/,"").trim();
  const tail=rest.slice(dm.index!+dm[0].length).trim();
  const AMTRE=/\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2}|\d+[,.]\s*\d{2}/g;
  let amounts=[...tail.matchAll(AMTRE)];
  if(!amounts.length) amounts=[...rest.matchAll(AMTRE)];
  const amount=amounts.length?cleanAmount(amounts[0][0]):null;
  if(!amount) return null;
  const nature=cleanNature(nat);
  const isCr=looksCredit(nature);
  return { date_operation:`${d1}/${m1}/${year}`, date_valeur:`${dm[1]}/${dm[2]}/${dm[3]}`, reference:code, libelle:nature||"Transaction", montant_debit:isCr?null:amount, montant_credit:isCr?amount:null };
}

// BP/BMCE/BMCI (adapté de bp_split_line)
function parseBP(line: string): any|null {
  const s=line.replace(/[lI](?=\d)/g," ").replace(/\//g," ").replace(/\s+/g," ").trim();
  let m=s.match(/^(\d{2})\s+(\d{2})\s+(20\d{2})\s+(\d{2})\s+(\d{2})\s+(20\d{2})\s+(.+)$/);
  if(!m){const m2=s.match(/^(\d{2})\s+(\d{2})\s+(20\d{2})\s+(\d{2})\s+(\d{2})\s+(.+)$/);if(m2)m=[m2[0],m2[1],m2[2],m2[3],m2[4],m2[5],m2[3],m2[6]];}
  if(!m) return null;
  const [,d1,mo1,y1,,,,rest]=m;
  const AMTRE=/\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2}|\d+[,.]\s*\d{2}/g;
  const ams=[...rest.matchAll(AMTRE)];
  if(!ams.length) return null;
  const amount=cleanAmount(ams[ams.length-1][0]);
  if(!amount) return null;
  const nature=cleanNature(rest.replace(ams[ams.length-1][0],"").replace(/\s+/g," ").trim());
  const isCr=looksCredit(nature);
  return { date_operation:`${d1}/${mo1}/${y1}`, date_valeur:`${d1}/${mo1}/${y1}`, reference:"", libelle:nature||"Transaction", montant_debit:isCr?null:amount, montant_credit:isCr?amount:null };
}

// CIH (DD/MM/YYYY [DD/MM/YYYY] [REF] LIBELLE MONTANT)
function parseCIH(line: string, year: number): any|null {
  const AMTRE=/\b(\d{1,3}(?:[\s.]\d{3})*,\d{2}|\d+,\d{2})\b/g;
  const amounts=[...line.matchAll(AMTRE)];
  if(!amounts.length) return null;
  const amount=cleanAmount(amounts[amounts.length-1][0]);
  if(!amount) return null;

  // DD/MM/YYYY DD/MM/YYYY [REF] LIBELLE MONTANT
  let m=line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})?\s*(?:(\w{4,10})\s+)?(.+?)\s+[\d\s]+,\d{2}\s*$/);
  if(m){
    const [,d1,,ref,lib]=m;
    const nature=cleanNature(lib.replace(/[\d\s]+,\d{2}/g,"").trim());
    const isCr=looksCredit(nature);
    return { date_operation:d1, date_valeur:d1, reference:ref||"", libelle:nature||"Transaction", montant_debit:isCr?null:amount, montant_credit:isCr?amount:null };
  }

  // DD/MM LIBELLE MONTANT (court)
  m=line.match(/^(\d{2})\/(\d{2})\s+(.+?)\s+[\d\s]+,\d{2}\s*$/);
  if(m){
    const [,d,mo,lib]=m;
    if(Number(d)>31||Number(mo)>12) return null;
    const nature=cleanNature(lib);
    const isCr=looksCredit(nature);
    return { date_operation:`${d}/${mo}/${year}`, date_valeur:`${d}/${mo}/${year}`, reference:"", libelle:nature||"Transaction", montant_debit:isCr?null:amount, montant_credit:isCr?amount:null };
  }
  return null;
}

// Parser complet multi-banques
function parserRelevePDF(text: string): { txs: any[]; info: InfoReleve } {
  const lower=text.toLowerCase();
  const banque=lower.includes("attijariwafa")?"Attijariwafa Bank"
    :lower.includes("banque populaire")?"Banque Populaire"
    :lower.includes("cih")?"CIH Bank"
    :lower.includes("bmce")||lower.includes("bank of africa")?"BMCE Bank of Africa"
    :lower.includes("bmci")?"BMCI"
    :lower.includes("société générale")||lower.includes("societe generale")?"Société Générale"
    :"Banque";

  // Soldes — adapté awb_soldes + bp_soldes du code Python
  const mInit=text.match(/SOLDE\s+DEPART\s+AU\s+\d{1,2}\s+\d{1,2}\s+\d{4}\s+([\d\s]+,\d{2})\s*(CREDITEUR|DEBITEUR)?/i)
    ??text.match(/ANCIEN\s+SOLDE\s+AU?[^\n]*([\d\s]+,\d{2})/i)
    ??text.match(/(?:SOLDE\s+DEPART|ANCIEN\s+SOLDE)[^\n]*([\d\s]+,\d{2})/i);
  const mFin=text.match(/SOLDE\s+FINAL\s+AU\s+\d{1,2}\s+\d{1,2}\s+\d{4}\s+([\d\s]+,\d{2})\s*(CREDITEUR|DEBITEUR)?/i)
    ??text.match(/SOLDE\s+A\s+REPORTER\s*:?\s*([\d\s]+,\d{2})/i)
    ??text.match(/(?:SOLDE\s+FINAL|SOLDE\s+A\s+REPORTER|NOUVEAU\s+SOLDE)[^\n]*([\d\s]+,\d{2})/i);

  const parseAmt=(m:RegExpMatchArray|null):number=>{
    if(!m) return 0;
    const val=m[1]; const n=cleanAmount(val??"")||0;
    return (m[2]??"").toUpperCase().startsWith("DEB")?-n:n;
  };

  const mRib=text.match(/(\d{3})\s+(\d{3})\s+([\d\s]{8,}?)\s+(\d{2})\b/);
  const rib=mRib?`${mRib[1]} ${mRib[2]} ${mRib[3].trim()} ${mRib[4]}`:"";

  const EXCL=["solde depart","solde final","solde a reporter","ancien solde","nouveau solde",
    "total mouvements","total des","banque populaire","attijariwafa","cih bank","bmce","bmci","societe generale",
    "agence","adresse","extrait de compte","releve de compte","code banque",
    "date oper","date valeur","libelle","debit","credit","montant","page n",
    "www.","sa au capital","ice :","rc :","if :","titulaire","morocco",
    "releve d'identite","releve d identite"];

  const year=new Date().getFullYear();
  let lines=text.split(/\n/).map(l=>l.trim()).filter(l=>l.length>5);

  // Fallback split si PDF.js met tout sur une ligne (join " ")
  const nbTx=lines.filter(l=>/^[0-9A-Z]{5,7}\s+\d{2}\s+\d{2}/.test(l)||/^\d{2}[\/\s]\d{2}[\/\s]20\d{2}/.test(l)).length;
  if(nbTx<3&&text.length>300){
    const parts=text.split(/(?=\b[0-9A-Z]{5,7}\s+\d{2}\s+\d{2}\s)|(?=\b\d{2}\s+\d{2}\s+20\d{2}\s+\d{2}\s+\d{2}\s+20\d{2}\s)|(?=\b\d{2}[\/\-]\d{2}[\/\-]20\d{2}\s)/);
    if(parts.length>5) lines=parts.map(p=>p.trim()).filter(p=>p.length>5);
  }

  const txs:any[]=[]; let ligneNum=1;
  for(const line of lines){
    const low=line.toLowerCase();
    if(EXCL.some(e=>low.includes(e))) continue;
    if(/^[\u0600-\u06FF\s,\.]+$/.test(line)) continue;
    if(/^\*+$|^-{3,}$|^={3,}$/.test(line)) continue;
    const tx=parseATW(line,year)??parseBP(line)??parseCIH(line,year);
    if(tx){tx.ligne=ligneNum++;txs.push(tx);}
  }

  return{txs,info:{banque,rib,solde_initial:parseAmt(mInit),solde_final:parseAmt(mFin)}};
}

// PCM mapping pour catégories
const PCM_MAP:Record<string,{code:string;tva:number}>={
  encaissement_client:{code:"3421",tva:0},
  paiement_fournisseur:{code:"4411",tva:20},
  salaires:{code:"6171",tva:0},
  cnss_amo:{code:"6174",tva:0},
  tva_dgi:{code:"4456",tva:0},
  loyers:{code:"6131",tva:20},
  eau_electricite:{code:"6125",tva:7},
  telecom:{code:"6132",tva:20},
  gasoil:{code:"6122",tva:20},
  assurance:{code:"6161",tva:0},
  entretien:{code:"6141",tva:20},
  frais_bancaires:{code:"6347",tva:10},
  frais_representation:{code:"6147",tva:0},
  frais_douane:{code:"6146",tva:0},
  retrait_especes:{code:"5161",tva:0},
  interets_crediteurs:{code:"7611",tva:0},
  transport:{code:"6145",tva:0},
  autre:{code:"6141",tva:0},
};

const CATEGORIES=[
  {value:"encaissement_client",label:"Encaissement client"},
  {value:"paiement_fournisseur",label:"Paiement fournisseur"},
  {value:"salaires",label:"Salaires"},
  {value:"cnss_amo",label:"CNSS / AMO"},
  {value:"tva_dgi",label:"TVA / Impôts DGI"},
  {value:"loyers",label:"Loyer / Location"},
  {value:"eau_electricite",label:"Eau / Électricité"},
  {value:"telecom",label:"Téléphone / Internet"},
  {value:"gasoil",label:"Gasoil / Carburant"},
  {value:"assurance",label:"Assurance"},
  {value:"entretien",label:"Entretien / Réparation"},
  {value:"frais_bancaires",label:"Frais bancaires"},
  {value:"frais_representation",label:"Frais de représentation"},
  {value:"frais_douane",label:"Frais douane / import"},
  {value:"retrait_especes",label:"Retrait espèces"},
  {value:"interets_crediteurs",label:"Intérêts créditeurs"},
  {value:"transport",label:"Transport / Déplacement"},
  {value:"autre",label:"Autre"},
];

// ─── Composant ────────────────────────────────────────────────────────────────
function BanquePage() {
  const { dossierId } = Route.useParams();
  const analyserFn = useServerFn(analyserReleveIA);

  const [tab, setTab] = useState<"comptes"|"releves"|"scanner"|"encaissements">("comptes");
  const [comptes, setComptes] = useState<Compte[]>([]);
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [transactions, setTransactions] = useState<TxBancaire[]>([]);
  const [releves, setReleves] = useState<Releve[]>([]);
  const [facturesNonPayees, setFacturesNonPayees] = useState<FactureNonPayee[]>([]);
  const [facturesClient, setFacturesClient] = useState<any[]>([]);
  const [facturesFourn, setFacturesFourn] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [dossier, setDossier] = useState<any>(null);

  // Scanner état
  const [scanLoading, setScanLoading] = useState(false);
  const [scanStep, setScanStep] = useState<"idle"|"review"|"done">("idle");
  const [txExtraites, setTxExtraites] = useState<TxExtracted[]>([]);
  const [infoReleve, setInfoReleve] = useState<InfoReleve|null>(null);
  const [releveCompteId, setReleveCompteId] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string|null>(null);
  const [remarques, setRemarques] = useState("");
  const [showRemarques, setShowRemarques] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedTx, setSelectedTx] = useState<number|null>(null);

  // Autres modals
  const [openCompte, setOpenCompte] = useState(false);
  const [openEncaissement, setOpenEncaissement] = useState(false);
  const [processing, setProcessing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [formCompte, setFormCompte] = useState({banque:"",intitule:"",rib:"",iban:"",solde_actuel:0});
  const [formEnc, setFormEnc] = useState({
    type:"especes" as "especes"|"cheque", montant:0,
    date_encaissement:new Date().toISOString().slice(0,10),
    reference:"",numero_cheque:"",banque_cheque:"",libelle:"",
    facture_id:"",facture_fournisseur_id:"",
  });

  const load = async () => {
    const [{data:c},{data:r},{data:fc},{data:ff},{data:fo},{data:cl},{data:dos}]=await Promise.all([
      supabase.from("comptes_bancaires").select("*").eq("dossier_id",dossierId).order("created_at"),
      (supabase as any).from("releves_bancaires").select("*").eq("dossier_id",dossierId).order("created_at",{ascending:false}),
      supabase.from("factures").select("id,numero,montant_ttc,montant_ht,montant_tva,date_facture,date_echeance,clients(id,nom,ice)").eq("dossier_id",dossierId).eq("statut","conforme").neq("statut_paiement","payee"),
      (supabase as any).from("factures_fournisseurs").select("id,numero,montant_ttc,montant_ht,montant_tva,date_facture,date_echeance,fournisseur_nom").eq("dossier_id",dossierId).neq("statut_paiement","payee"),
      (supabase as any).from("fournisseurs").select("id,nom,ice").eq("dossier_id",dossierId),
      supabase.from("clients").select("id,nom,ice").eq("dossier_id",dossierId),
      supabase.from("dossiers" as any).select("nom_societe,ice").eq("id",dossierId).single(),
    ]);
    setComptes((c??[]) as Compte[]);
    setReleves((r??[]) as Releve[]);
    setFacturesClient(fc??[]);
    setFacturesFourn(ff??[]);
    setFournisseurs(fo??[]);
    setClients(cl??[]);
    setDossier((dos as any)??null);
    setFacturesNonPayees([
      ...((fc??[]) as any[]).map((f:any)=>({id:f.id,type:"client" as const,numero:f.numero,nom:(f.clients as any)?.nom??"Client",montant_ttc:Number(f.montant_ttc),date_echeance:f.date_echeance})),
      ...((ff??[]) as any[]).map((f:any)=>({id:f.id,type:"fournisseur" as const,numero:f.numero,nom:f.fournisseur_nom??"Fournisseur",montant_ttc:Number(f.montant_ttc),date_echeance:f.date_echeance})),
    ]);
  };

  const loadTx=async(cid:string)=>{
    const{data}=await supabase.from("transactions_bancaires").select("*").eq("compte_id",cid).order("date_operation",{ascending:false}).limit(100);
    setTransactions((data??[]) as TxBancaire[]);
  };

  useEffect(()=>{load();},[dossierId]);
  useEffect(()=>{if(selectedId)loadTx(selectedId);},[selectedId]);

  const selected=comptes.find(c=>c.id===selectedId);

  // ── SCANNER RELEVÉ ────────────────────────────────────────────────────────
  const handleReleveUpload=async(file:File)=>{
    if(!releveCompteId){toast.error("Sélectionnez d'abord un compte bancaire");return;}
    setScanLoading(true);
    setPdfUrl(URL.createObjectURL(file));
    try{
      // Extraction PDF
      const pdfjsLib=await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc=`https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
      const ab=await file.arrayBuffer();
      const pdf=await pdfjsLib.getDocument({data:ab}).promise;
      let fullText="";
      for(let i=1;i<=pdf.numPages;i++){
        const page=await pdf.getPage(i);
        const content=await page.getTextContent();
        // CRITIQUE: reconstruction par Y pour vraies lignes
        const items=content.items as any[];
        let lastY=-1,lineText="";
        for(const item of items){
          const y=Math.round(item.transform[5]);
          if(lastY!==-1&&Math.abs(y-lastY)>3){fullText+=lineText.trimEnd()+"\n";lineText="";}
          lineText+=item.str+" ";lastY=y;
        }
        if(lineText.trim()) fullText+=lineText.trimEnd()+"\n";
      }

      // Parser multi-banques
      const{txs:txBrutes,info}=parserRelevePDF(fullText);
      setInfoReleve(info);

      if(txBrutes.length===0){
        toast.error("Aucune transaction détectée. Ce PDF est peut-être une image non OCRisée.");
        setScanLoading(false);return;
      }

      toast.info(`${txBrutes.length} transactions extraites — analyse IA en cours…`);

      // Analyse IA: catégorisation + matching
      const result=await analyserFn({
        data:{
          transactions_brutes:txBrutes,
          factures_client:facturesClient, factures_fourn:facturesFourn,
          clients, fournisseurs,
          dossier_nom:dossier?.nom_societe??"",
          dossier_ice:dossier?.ice??"",
          remarques,
        },
      });

      // Fusionner parser + IA
      const txFinal:TxExtracted[]=txBrutes.map((tx:any,idx:number)=>{
        const a=result.analyses.find((x:any)=>x.i===idx)??result.analyses[idx]??{};
        const cat=a.categorie??"autre";
        const pcm=PCM_MAP[cat]??{code:"6141",tva:0};
        const montant=tx.montant_credit??tx.montant_debit??0;
        const ht=pcm.tva>0?Math.round(montant/(1+pcm.tva/100)*100)/100:montant;
        const tva=pcm.tva>0?Math.round((montant-ht)*100)/100:0;
        return{
          date_operation:tx.date_operation,
          date_valeur:tx.date_valeur,
          reference:tx.reference??"",
          libelle:tx.libelle??"Transaction",
          type:(tx.montant_credit?"credit":"debit") as "credit"|"debit",
          montant:tx.montant_credit??tx.montant_debit??0,
          categorie:cat,
          compte_comptable:a.code_pcm??pcm.code,
          reference_facture:a.facture_num??null,
          confiance:a.confiance??50,
          facture_id:a.facture_id??null,
          alerte:a.alerte??null,
        };
      });

      setTxExtraites(txFinal);
      setScanStep("review");
      const nbMatch=txFinal.filter(t=>t.facture_id).length;
      toast.success(`${txFinal.length} transactions analysées${nbMatch>0?` — ${nbMatch} matchées avec factures`:""}`);
    }catch(e:any){toast.error("Erreur: "+e.message);}
    finally{setScanLoading(false);}
  };

  const updateTxExtrait=(idx:number,updates:Partial<TxExtracted>)=>{
    setTxExtraites(prev=>prev.map((tx,i)=>{
      if(i!==idx) return tx;
      const updated={...tx,...updates};
      if(updates.categorie){
        const pcm=PCM_MAP[updates.categorie]??{code:"6141",tva:0};
        updated.compte_comptable=pcm.code;
      }
      return updated;
    }));
  };

  const handleValiderReleve=async()=>{
    if(!txExtraites.length||!releveCompteId) return;
    setSaving(true);
    try{
      const compte=comptes.find(c=>c.id===releveCompteId);
      let soldeCourant=compte?.solde_actuel??0;

      const txToInsert=txExtraites.map(tx=>({
        compte_id:releveCompteId,dossier_id:dossierId,
        date_operation:tx.date_operation,libelle:tx.libelle,
        type:tx.type,montant:tx.montant,
        solde_apres:0,rapproche:!!tx.facture_id,
      }));

      for(const tx of txToInsert){
        soldeCourant=Math.round((soldeCourant+(tx.type==="credit"?tx.montant:-tx.montant))*100)/100;
        tx.solde_apres=soldeCourant;
      }

      await supabase.from("transactions_bancaires").insert(txToInsert);
      await supabase.from("comptes_bancaires").update({solde_actuel:soldeCourant}).eq("id",releveCompteId);

      // Écritures comptables PCM
      const ecritures:any[]=[];
      const fcPay:string[]=[],ffPay:string[]=[];

      for(const tx of txExtraites){
        const parts=tx.date_operation.split("/");
        const date=parts.length===3&&parts[2].length===4?`${parts[2]}-${parts[1]}-${parts[0]}`:tx.date_operation;
        const libelle=tx.libelle.slice(0,100);
        const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:0};
        const ht=pcm.tva>0?Math.round(tx.montant/(1+pcm.tva/100)*100)/100:tx.montant;
        const tva=pcm.tva>0?Math.round((tx.montant-ht)*100)/100:0;

        // Écriture banque 5141
        ecritures.push({dossier_id:dossierId,journal_code:"BQ",compte_numero:"5141",date_ecriture:date,libelle,debit:tx.type==="credit"?tx.montant:0,credit:tx.type==="debit"?tx.montant:0,reference_piece:tx.reference_facture||tx.reference,valide:true});

        // Contre-écriture PCM
        if(tva>0&&tx.type==="debit"){
          ecritures.push({dossier_id:dossierId,journal_code:"BQ",compte_numero:tx.compte_comptable,date_ecriture:date,libelle,debit:ht,credit:0,reference_piece:tx.reference_facture,valide:true});
          ecritures.push({dossier_id:dossierId,journal_code:"BQ",compte_numero:"34552",date_ecriture:date,libelle:`TVA ${libelle.slice(0,50)}`,debit:tva,credit:0,reference_piece:tx.reference_facture,valide:true});
        }else{
          ecritures.push({dossier_id:dossierId,journal_code:"BQ",compte_numero:tx.compte_comptable,date_ecriture:date,libelle,debit:tx.type==="debit"?0:ht,credit:tx.type==="credit"?0:ht,reference_piece:tx.reference_facture,valide:true});
        }

        // Marquer factures matchées
        if(tx.facture_id){
          const fc=facturesClient.find((f:any)=>f.id===tx.facture_id);
          const ff=facturesFourn.find((f:any)=>f.id===tx.facture_id);
          if(fc) fcPay.push(tx.facture_id);
          else if(ff) ffPay.push(tx.facture_id);
        }
      }

      await supabase.from("ecritures_comptables").insert(ecritures);
      if(fcPay.length>0) await supabase.from("factures").update({statut_paiement:"payee",date_paiement:new Date().toISOString().slice(0,10)}).in("id",fcPay);
      if(ffPay.length>0) await (supabase as any).from("factures_fournisseurs").update({statut_paiement:"payee",date_paiement:new Date().toISOString().slice(0,10)}).in("id",ffPay);

      await (supabase as any).from("releves_bancaires").insert({
        compte_id:releveCompteId,dossier_id:dossierId,
        nombre_transactions:txExtraites.length,
        solde_initial:compte?.solde_actuel??0,
        solde_final:soldeCourant,statut:"valide",
        fichier_nom:"relevé importé",
      });

      const nbPay=fcPay.length+ffPay.length;
      toast.success(`${txExtraites.length} transactions enregistrées + écritures PCM créées`+(nbPay>0?` — ${nbPay} facture(s) payée(s)`:""));
      setScanStep("done");
      load();
      if(selectedId) loadTx(selectedId);
    }catch(e:any){toast.error(e.message);}
    finally{setSaving(false);}
  };

  const genererBilan=()=>{
    const rows=[["Date","Journal","Compte","Libellé","Débit","Crédit","Catégorie","Réf."]];
    for(const tx of txExtraites){
      const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:0};
      const ht=pcm.tva>0?Math.round(tx.montant/(1+pcm.tva/100)*100)/100:tx.montant;
      rows.push([tx.date_operation,"BQ","5141",tx.libelle,tx.type==="credit"?String(tx.montant):"",tx.type==="debit"?String(tx.montant):"",tx.categorie,tx.reference_facture||""]);
      rows.push([tx.date_operation,"BQ",tx.compte_comptable,tx.libelle,tx.type==="debit"?String(ht):"",tx.type==="credit"?String(ht):"",tx.categorie,tx.reference_facture||""]);
    }
    const blob=new Blob(["\uFEFF"+rows.map(r=>r.join(";")).join("\n")],{type:"text/csv;charset=utf-8;"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`Bilan_BQ_${new Date().toISOString().slice(0,10)}.csv`;a.click();
    toast.success("Bilan Sage généré");
  };

  const resetScan=()=>{setScanStep("idle");setTxExtraites([]);setInfoReleve(null);setPdfUrl(null);setSelectedTx(null);};

  // ── Encaissement (code original préservé) ─────────────────────────────────
  const handleEncaissement=async()=>{
    if(!formEnc.montant||!formEnc.date_encaissement) return toast.error("Montant et date requis");
    setProcessing(true);
    try{
      const{error}=await (supabase as any).from("encaissements").insert({
        dossier_id:dossierId,type:formEnc.type,montant:formEnc.montant,
        date_encaissement:formEnc.date_encaissement,reference:formEnc.reference||null,
        numero_cheque:formEnc.numero_cheque||null,banque_cheque:formEnc.banque_cheque||null,
        libelle:formEnc.libelle||null,facture_id:formEnc.facture_id||null,
        facture_fournisseur_id:formEnc.facture_fournisseur_id||null,valide:true,
      });
      if(error) throw error;
      const journalCode=formEnc.type==="especes"?"CAI":"BQ";
      const compteDebit=formEnc.type==="especes"?"5161":"5141";
      const compteContre=formEnc.facture_id?"3421":formEnc.facture_fournisseur_id?"4411":"7111";
      await supabase.from("ecritures_comptables").insert([
        {dossier_id:dossierId,journal_code:journalCode,compte_numero:compteDebit,date_ecriture:formEnc.date_encaissement,libelle:formEnc.libelle||`Encaissement ${formEnc.type}`,debit:formEnc.montant,credit:0,reference_piece:formEnc.reference||null,valide:true},
        {dossier_id:dossierId,journal_code:journalCode,compte_numero:compteContre,date_ecriture:formEnc.date_encaissement,libelle:formEnc.libelle||"Règlement",debit:0,credit:formEnc.montant,reference_piece:formEnc.reference||null,valide:true},
      ]);
      if(formEnc.facture_id) await supabase.from("factures").update({statut_paiement:"payee",date_paiement:formEnc.date_encaissement}).eq("id",formEnc.facture_id);
      if(formEnc.facture_fournisseur_id) await (supabase as any).from("factures_fournisseurs").update({statut_paiement:"payee",date_paiement:formEnc.date_encaissement}).eq("id",formEnc.facture_fournisseur_id);
      toast.success("Encaissement enregistré + écriture créée");
      setOpenEncaissement(false);
      setFormEnc({type:"especes",montant:0,date_encaissement:new Date().toISOString().slice(0,10),reference:"",numero_cheque:"",banque_cheque:"",libelle:"",facture_id:"",facture_fournisseur_id:""});
      load();
    }catch(e:any){toast.error(e.message);}
    finally{setProcessing(false);}
  };

  const confColor=(c:number)=>c>=90?"text-green-600":c>=70?"text-yellow-500":"text-red-500";
  const getCatLabel=(v:string)=>CATEGORIES.find(c=>c.value===v)?.label??v;
  const totalCr=txExtraites.reduce((s,t)=>s+(t.type==="credit"?t.montant:0),0);
  const totalDb=txExtraites.reduce((s,t)=>s+(t.type==="debit"?t.montant:0),0);
  const nbMatch=txExtraites.filter(t=>t.facture_id).length;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Banque & Trésorerie</h1>
          <p className="text-muted-foreground mt-1">Relevés bancaires · Rapprochement auto · Encaissements espèces/chèques</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={()=>setOpenEncaissement(true)}>
            <FileText className="h-4 w-4 mr-2"/>Encaissement espèces/chèque
          </Button>
          <Button onClick={()=>setOpenCompte(true)}>
            <Plus className="h-4 w-4 mr-2"/>Compte bancaire
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={v=>setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="comptes">Comptes ({comptes.length})</TabsTrigger>
          <TabsTrigger value="releves">Relevés importés ({releves.length})</TabsTrigger>
          <TabsTrigger value="scanner">
            📄 Scanner relevé
            {facturesNonPayees.length>0&&<span className="ml-2 bg-orange-500 text-white text-xs px-1.5 py-0.5 rounded-full">{facturesNonPayees.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="encaissements">Encaissements espèces/chèques</TabsTrigger>
        </TabsList>

        {/* ── COMPTES ── */}
        <TabsContent value="comptes" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {comptes.length===0?(
              <Card className="col-span-3"><CardContent className="py-12 text-center text-muted-foreground">
                <Landmark className="h-10 w-10 mx-auto mb-2 opacity-30"/>
                <p>Aucun compte bancaire — créez-en un</p>
              </CardContent></Card>
            ):comptes.map(c=>(
              <Card key={c.id} className={`cursor-pointer transition-all ${selectedId===c.id?"ring-2 ring-primary":"hover:shadow-md"}`}
                onClick={()=>setSelectedId(c.id===selectedId?null:c.id)}>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-muted-foreground">{c.banque}</span>
                    <Landmark className="h-4 w-4 text-muted-foreground"/>
                  </div>
                  <p className="font-semibold">{c.intitule}</p>
                  <p className="font-mono text-xs text-muted-foreground mt-1">{c.rib}</p>
                  <p className={`text-2xl font-bold mt-3 ${c.solde_actuel>=0?"text-green-600":"text-red-600"}`}>{fmt(c.solde_actuel)}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          {selectedId&&(
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold">Transactions — {selected?.intitule}</h2>
                <Button size="sm" onClick={()=>{setReleveCompteId(selectedId);setTab("scanner");}}>
                  <Upload className="h-3 w-3 mr-1"/>Importer relevé
                </Button>
              </div>
              <Card><CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Date</TableHead><TableHead>Libellé</TableHead><TableHead>Type</TableHead>
                    <TableHead className="text-right">Montant</TableHead><TableHead className="text-right">Solde</TableHead><TableHead>Rapproché</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {transactions.length===0
                      ?<TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Importez un relevé dans l'onglet "Scanner relevé"</TableCell></TableRow>
                      :transactions.map(t=>(
                        <TableRow key={t.id}>
                          <TableCell className="text-sm">{new Date(t.date_operation).toLocaleDateString("fr-MA")}</TableCell>
                          <TableCell className="text-sm max-w-[250px] truncate">{t.libelle}</TableCell>
                          <TableCell>
                            <Badge className={t.type==="credit"?"bg-green-100 text-green-700":"bg-red-100 text-red-700"}>
                              {t.type==="credit"?<TrendingUp className="h-3 w-3 mr-1"/>:<TrendingDown className="h-3 w-3 mr-1"/>}{t.type}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-right font-mono text-sm ${t.type==="credit"?"text-green-600":"text-red-600"}`}>
                            {t.type==="credit"?"+":"-"}{fmt(t.montant)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{t.solde_apres!=null?fmt(t.solde_apres):"—"}</TableCell>
                          <TableCell>
                            {t.rapproche
                              ?<Badge className="bg-green-100 text-green-700 text-xs"><CheckCircle className="h-3 w-3 mr-1"/>Oui</Badge>
                              :<Badge variant="secondary" className="text-xs">Non</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent></Card>
            </>
          )}
        </TabsContent>

        {/* ── RELEVÉS ── */}
        <TabsContent value="releves" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Fichier</TableHead><TableHead>Compte</TableHead>
                <TableHead>Transactions</TableHead><TableHead>Solde final</TableHead><TableHead>Statut</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {releves.length===0
                  ?<TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">Aucun relevé importé — utilisez l'onglet "Scanner relevé"</TableCell></TableRow>
                  :releves.map(r=>(
                    <TableRow key={r.id}>
                      <TableCell className="text-sm">{r.fichier_nom??"Relevé"}</TableCell>
                      <TableCell className="text-sm">{comptes.find(c=>c.id===(r as any).compte_id)?.intitule??"—"}</TableCell>
                      <TableCell className="font-mono text-sm">{r.nombre_transactions}</TableCell>
                      <TableCell className="font-mono text-sm">{fmt(Number(r.solde_final))}</TableCell>
                      <TableCell><Badge variant={(r.statut as any)==="valide"?"default":"secondary"}>{(r.statut as any)==="valide"?"✅ Validé":r.statut}</Badge></TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        {/* ── SCANNER ── */}
        <TabsContent value="scanner" className="mt-4">
          {scanStep==="idle"&&(
            <div className="space-y-4">
              {facturesNonPayees.length>0&&(
                <Card className="border-orange-200">
                  <CardContent className="pt-4 pb-4">
                    <p className="font-medium text-sm mb-2 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-orange-500"/>
                      {facturesNonPayees.length} facture(s) en attente de paiement — matching automatique
                    </p>
                    <div className="space-y-1">
                      {facturesNonPayees.slice(0,5).map(f=>(
                        <div key={f.id} className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{f.type==="client"?"📤":"📥"} {f.nom} — {f.numero}</span>
                          <span className="font-mono font-semibold">{fmt(f.montant_ttc)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="space-y-2">
                <Label>Compte bancaire *</Label>
                <Select value={releveCompteId} onValueChange={setReleveCompteId}>
                  <SelectTrigger className="max-w-sm"><SelectValue placeholder="Sélectionner le compte…"/></SelectTrigger>
                  <SelectContent>{comptes.map(c=><SelectItem key={c.id} value={c.id}>{c.intitule} — {c.banque}</SelectItem>)}</SelectContent>
                </Select>
              </div>

              <div className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer hover:border-primary transition-colors max-w-2xl"
                onClick={()=>fileRef.current?.click()}
                onDragOver={e=>e.preventDefault()}
                onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)handleReleveUpload(f);}}>
                <input ref={fileRef} type="file" className="hidden" accept=".pdf"
                  onChange={e=>{const f=e.target.files?.[0];if(f)handleReleveUpload(f);}}/>
                {scanLoading
                  ?<><Loader2 className="h-10 w-10 animate-spin mx-auto text-primary mb-2"/><p className="font-medium">Extraction + Analyse IA en cours…</p><p className="text-xs text-muted-foreground mt-1">Parser multi-banques → Gemini/Groq catégorisation + matching factures</p></>
                  :<><Upload className="h-10 w-10 mx-auto mb-2 text-muted-foreground"/><p className="font-medium text-lg">Glissez votre relevé bancaire PDF</p><p className="text-sm text-muted-foreground mt-1">Attijariwafa · Banque Populaire · CIH · BMCE · BMCI · Société Générale</p><p className="text-xs text-muted-foreground mt-2 opacity-70">Extraction automatique + matching factures + codes PCM marocains</p></>
                }
              </div>
            </div>
          )}

          {scanStep==="review"&&(
            <div className="space-y-4">
              {/* Header stats */}
              <div className="flex items-center justify-between">
                <div className="flex gap-3">
                  <Badge variant="outline">{txExtraites.length} transactions</Badge>
                  <Badge className="bg-green-600">+{fmt(totalCr)}</Badge>
                  <Badge className="bg-red-600">-{fmt(totalDb)}</Badge>
                  {nbMatch>0&&<Badge className="bg-blue-600">🔗 {nbMatch} matchées</Badge>}
                  {infoReleve&&<Badge variant="outline">{infoReleve.banque}</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={()=>setShowRemarques(true)}><RefreshCw className="h-3.5 w-3.5 mr-1.5"/>Rescanner</Button>
                  <Button variant="outline" size="sm" onClick={genererBilan}><Download className="h-3.5 w-3.5 mr-1.5"/>Bilan Sage</Button>
                  <Button size="sm" onClick={handleValiderReleve} disabled={saving}>
                    {saving?<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin"/>:<CheckCircle className="h-3.5 w-3.5 mr-1.5"/>}
                    Valider et enregistrer
                  </Button>
                  <Button variant="ghost" size="sm" onClick={resetScan}><X className="h-3.5 w-3.5"/></Button>
                </div>
              </div>

              {/* Soldes */}
              {infoReleve&&(
                <div className="grid grid-cols-4 gap-3">
                  {[
                    {label:"Banque",value:infoReleve.banque,color:"text-primary"},
                    {label:"RIB",value:infoReleve.rib||"—",color:"text-muted-foreground"},
                    {label:"Solde initial",value:fmt(infoReleve.solde_initial),color:"text-blue-600"},
                    {label:"Solde final",value:fmt(infoReleve.solde_final),color:"text-blue-700"},
                  ].map(k=>(
                    <Card key={k.label} className="border-0 bg-muted/40">
                      <CardContent className="pt-3 pb-3">
                        <p className="text-[10px] text-muted-foreground uppercase">{k.label}</p>
                        <p className={`font-semibold text-sm mt-0.5 ${k.color}`}>{k.value}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {/* Tableau transactions */}
              <Card><CardContent className="p-0">
                <div className="max-h-[500px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card z-10">
                      <TableRow>
                        <TableHead className="w-8">#</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Libellé</TableHead>
                        <TableHead>Catégorie</TableHead>
                        <TableHead>Code PCM</TableHead>
                        <TableHead className="text-right">Montant</TableHead>
                        <TableHead>Match</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {txExtraites.map((tx,idx)=>(
                        <>
                          <TableRow key={idx}
                            className={`cursor-pointer ${selectedTx===idx?"bg-primary/5":""} ${tx.facture_id?"border-l-2 border-l-green-500":""} ${tx.alerte?"border-l-2 border-l-orange-400":""}`}
                            onClick={()=>setSelectedTx(selectedTx===idx?null:idx)}>
                            <TableCell className="text-xs text-muted-foreground">{idx+1}</TableCell>
                            <TableCell className="text-xs font-mono">{tx.date_operation}</TableCell>
                            <TableCell className="text-sm max-w-[200px]">
                              <p className="truncate">{tx.libelle}</p>
                              {tx.alerte&&<p className="text-[10px] text-orange-600">⚠️ {tx.alerte}</p>}
                            </TableCell>
                            <TableCell onClick={e=>e.stopPropagation()}>
                              <Select value={tx.categorie} onValueChange={v=>updateTxExtrait(idx,{categorie:v})}>
                                <SelectTrigger className="h-7 text-xs w-44">
                                  <div className="flex items-center gap-1">
                                    <span className={`text-xs ${confColor(tx.confiance)}`}>●</span>
                                    <span className="truncate">{getCatLabel(tx.categorie)}</span>
                                  </div>
                                </SelectTrigger>
                                <SelectContent>
                                  {CATEGORIES.map(c=><SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="font-mono text-xs">{tx.compte_comptable}</TableCell>
                            <TableCell className={`text-right font-mono text-sm font-semibold ${tx.type==="credit"?"text-green-600":"text-red-600"}`}>
                              {tx.type==="credit"?"+":"-"}{fmt(tx.montant)}
                            </TableCell>
                            <TableCell>
                              {tx.facture_id
                                ?<Badge className="bg-green-100 text-green-700 text-xs">🔗 {tx.reference_facture||"Facture"}</Badge>
                                :tx.alerte
                                ?<Badge className="bg-orange-100 text-orange-700 text-xs">⚠️ Vérifier</Badge>
                                :<Badge variant="secondary" className="text-xs">Auto</Badge>}
                            </TableCell>
                          </TableRow>
                          {selectedTx===idx&&(
                            <TableRow key={`${idx}-detail`}>
                              <TableCell colSpan={7} className="bg-muted/30 p-3">
                                <div className="grid grid-cols-3 gap-3">
                                  <div><p className="text-xs text-muted-foreground mb-1">Référence</p><p className="text-xs font-mono">{tx.reference||"—"}</p></div>
                                  <div><p className="text-xs text-muted-foreground mb-1">Date valeur</p><p className="text-xs font-mono">{tx.date_valeur}</p></div>
                                  <div><p className="text-xs text-muted-foreground mb-1">Confiance IA</p><p className={`text-xs font-semibold ${confColor(tx.confiance)}`}>{tx.confiance}%</p></div>
                                  {tx.facture_id&&<div className="col-span-3"><p className="text-xs text-green-700">✅ Facture matchée ID: {tx.facture_id.slice(0,8)}… — {tx.reference_facture}</p></div>}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent></Card>
            </div>
          )}

          {scanStep==="done"&&(
            <div className="text-center py-16">
              <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4"/>
              <h2 className="text-xl font-bold mb-2">Relevé enregistré avec succès</h2>
              <p className="text-muted-foreground mb-6">{txExtraites.length} transactions · Écritures PCM créées · Factures mises à jour</p>
              <div className="flex gap-3 justify-center">
                <Button variant="outline" onClick={genererBilan}><Download className="h-4 w-4 mr-2"/>Bilan Sage</Button>
                <Button onClick={()=>{resetScan();setTab("comptes");}}>Voir les transactions</Button>
                <Button variant="outline" onClick={resetScan}>Nouveau relevé</Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── ENCAISSEMENTS ── */}
        <TabsContent value="encaissements" className="mt-4">
          <div className="mb-4 p-4 bg-muted rounded-lg text-sm">
            <p className="font-medium mb-1">Encaissements hors virement bancaire</p>
            <p className="text-muted-foreground">Espèces ou chèque — enregistrés dans le journal de caisse (5161) ou banque (5141).</p>
          </div>
          <Button onClick={()=>setOpenEncaissement(true)}><Plus className="h-4 w-4 mr-2"/>Saisir un encaissement</Button>
        </TabsContent>
      </Tabs>

      {/* Modal rescanner */}
      <Dialog open={showRemarques} onOpenChange={setShowRemarques}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Rescanner avec remarques</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Précisions pour améliorer la catégorisation :</p>
            <textarea value={remarques} onChange={e=>setRemarques(e.target.value)}
              placeholder="Ex : FIRSTAUM = loyer bureau, CNSS le 10 du mois, ATLAS = fournisseur emballage…"
              rows={4} className="w-full text-sm border rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"/>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setShowRemarques(false)}>Annuler</Button>
            <Button onClick={()=>{setShowRemarques(false);fileRef.current?.click();}}>
              <Sparkles className="h-4 w-4 mr-2"/>Rescanner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal encaissement (code original) */}
      <Dialog open={openEncaissement} onOpenChange={setOpenEncaissement}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Encaissement espèces / chèque</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Type *</Label>
              <Select value={formEnc.type} onValueChange={v=>setFormEnc({...formEnc,type:v as "especes"|"cheque"})}>
                <SelectTrigger><SelectValue/></SelectTrigger>
                <SelectContent><SelectItem value="especes">💵 Espèces</SelectItem><SelectItem value="cheque">🏦 Chèque</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Montant (MAD) *</Label><Input type="number" step="0.01" value={formEnc.montant} onChange={e=>setFormEnc({...formEnc,montant:parseFloat(e.target.value)||0})}/></div>
              <div className="space-y-2"><Label>Date *</Label><Input type="date" value={formEnc.date_encaissement} onChange={e=>setFormEnc({...formEnc,date_encaissement:e.target.value})}/></div>
            </div>
            {formEnc.type==="cheque"&&(
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>N° chèque</Label><Input value={formEnc.numero_cheque} onChange={e=>setFormEnc({...formEnc,numero_cheque:e.target.value})}/></div>
                <div className="space-y-2"><Label>Banque</Label><Input value={formEnc.banque_cheque} onChange={e=>setFormEnc({...formEnc,banque_cheque:e.target.value})}/></div>
              </div>
            )}
            <div className="space-y-2"><Label>Libellé</Label><Input value={formEnc.libelle} onChange={e=>setFormEnc({...formEnc,libelle:e.target.value})} placeholder="Paiement facture F2026-001…"/></div>
            <div className="space-y-2">
              <Label>Facture concernée (optionnel)</Label>
              <Select value={formEnc.facture_id||formEnc.facture_fournisseur_id||"none"}
                onValueChange={v=>{
                  if(v==="none"){setFormEnc({...formEnc,facture_id:"",facture_fournisseur_id:""});return;}
                  const f=facturesNonPayees.find(f=>f.id===v);
                  if(f?.type==="client") setFormEnc({...formEnc,facture_id:v,facture_fournisseur_id:"",montant:f.montant_ttc});
                  else if(f?.type==="fournisseur") setFormEnc({...formEnc,facture_fournisseur_id:v,facture_id:"",montant:f.montant_ttc});
                }}>
                <SelectTrigger><SelectValue placeholder="Aucune facture liée"/></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Aucune facture liée</SelectItem>
                  {facturesNonPayees.map(f=>(<SelectItem key={f.id} value={f.id}>{f.type==="client"?"📤":"📥"} {f.nom} — {f.numero} — {fmt(f.montant_ttc)}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setOpenEncaissement(false)}>Annuler</Button>
            <Button onClick={handleEncaissement} disabled={processing}>
              {processing?<Loader2 className="h-4 w-4 mr-2 animate-spin"/>:<CheckCircle className="h-4 w-4 mr-2"/>}Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal compte (code original) */}
      <Dialog open={openCompte} onOpenChange={setOpenCompte}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nouveau compte bancaire</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label>Banque</Label><Input value={formCompte.banque} onChange={e=>setFormCompte({...formCompte,banque:e.target.value})} placeholder="Attijariwafa, CIH, BMCE…"/></div>
            <div className="space-y-2"><Label>Intitulé</Label><Input value={formCompte.intitule} onChange={e=>setFormCompte({...formCompte,intitule:e.target.value})}/></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>RIB</Label><Input value={formCompte.rib} onChange={e=>setFormCompte({...formCompte,rib:e.target.value})}/></div>
              <div className="space-y-2"><Label>Solde initial (MAD)</Label><Input type="number" value={formCompte.solde_actuel} onChange={e=>setFormCompte({...formCompte,solde_actuel:parseFloat(e.target.value)||0})}/></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setOpenCompte(false)}>Annuler</Button>
            <Button onClick={async()=>{
              const{error}=await supabase.from("comptes_bancaires").insert({dossier_id:dossierId,...formCompte,iban:formCompte.iban||null});
              if(error) return toast.error(error.message);
              toast.success("Compte créé");setOpenCompte(false);
              setFormCompte({banque:"",intitule:"",rib:"",iban:"",solde_actuel:0});load();
            }}>Créer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


