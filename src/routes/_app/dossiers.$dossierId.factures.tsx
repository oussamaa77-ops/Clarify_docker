import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { generateFactureXml, marquerPayee, ocrFacture, ajouterEmailClient } from "@/server/factures.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, FileCode, Eye, CheckCircle, Upload, Loader2, Download, X, AlertCircle, CheckCircle2, UserPlus, Clock, Mail, FileText, Trash2 } from "lucide-react";
import { toast } from "sonner";
 
export const Route = createFileRoute("/_app/dossiers/$dossierId/factures")({ component: FacturesPage });
 
interface Ligne { designation: string; quantite: number; prix_unitaire: number; taux_tva: number }
interface Client { id: string; nom: string; ice: string | null; email: string | null }
interface Facture {
  id: string; numero: string | null; date_facture: string; date_echeance: string | null;
  client_id: string | null; statut: string; statut_paiement: string; statut_dgi: string | null;
  montant_ht: number; montant_ttc: number; montant_tva: number;
  type_facture: string; montant_paye: number; montant_restant: number; mode_reglement: string | null;
  xml_ubl: string | null; hash_sha256: string | null; dgi_uuid: string | null; dgi_response: any;
  fichier_original_url: string | null; fichier_original_nom: string | null; fichier_original_type: string | null;
}
 
interface OcrData {
  client_nom_extrait: string; ice_client: string | null; numero_facture: string | null;
  date_facture: string | null; date_echeance: string | null; delai_paiement_jours: number | null;
  mode_reglement: string | null; montant_ht: number; montant_tva: number; montant_ttc: number;
  type_facture: string; numero_commande: string | null; numero_acompte: number | null;
  montant_commande_total_ht: number | null; montant_commande_total_ttc: number | null;
  montant_restant_du: number | null; lignes: Ligne[]; confidence: string; method: string;
  client_id: string | null; client_action: "found"|"created"|"not_found"; client_trouve: any;
  sens_facture: string; emetteur_nom: string | null;
}
 
const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";
 
function StatutPaiementBadge({ f }: { f: Facture }) {
  if (f.statut_paiement === "payee")
    return <Badge className="bg-green-100 text-green-700 text-xs">✅ Payée</Badge>;
  if (f.statut_paiement === "partielle")
    return <Badge className="bg-blue-100 text-blue-700 text-xs">🔵 Acompte partiel</Badge>;
  return <Badge variant="secondary" className="text-xs">En attente</Badge>;
}
 
function DGIBadge({ statut, statut_dgi }: { statut: string; statut_dgi: string | null }) {
  if (statut_dgi === "en_analyse" || statut === "envoyee")
    return <Badge className="bg-yellow-100 text-yellow-800 text-xs flex items-center gap-1"><Clock className="h-3 w-3"/>En analyse</Badge>;
  if (statut === "conforme" || statut_dgi === "conforme")
    return <Badge className="bg-green-100 text-green-800 text-xs">✅ Conforme</Badge>;
  if (statut === "rejetee" || statut_dgi === "rejetee")
    return <Badge variant="destructive" className="text-xs">❌ Rejeté</Badge>;
  return <Badge variant="secondary" className="text-xs">{statut}</Badge>;
}
 
function FacturesPage() {
  const { dossierId } = Route.useParams();
  const genXml = useServerFn(generateFactureXml);
  const payFn  = useServerFn(marquerPayee);
  const ocrFn  = useServerFn(ocrFacture);
  const addEmailFn = useServerFn(ajouterEmailClient);
 
  const [factures, setFactures] = useState<Facture[]>([]);
  const [clients, setClients]   = useState<Client[]>([]);
  const [loading, setLoading]   = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [viewXml, setViewXml]   = useState<Facture | null>(null);
  const [dgiResult, setDgiResult] = useState<any>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
 
  const [emailModal, setEmailModal] = useState<{clientId:string;factureId:string}|null>(null);
  const [emailInput, setEmailInput] = useState("");
 
  // Formulaire
  const [clientId, setClientId]   = useState("");
  const [numero, setNumero]       = useState("");
  const [dateF, setDateF]         = useState(new Date().toISOString().slice(0,10));
  const [dateE, setDateE]         = useState("");
  const [modeReglement, setModeReglement] = useState("virement");
  const [typeFacture, setTypeFacture]     = useState("standard");
  const [montantPaye, setMontantPaye]     = useState(0);
  const [montantRestant, setMontantRestant] = useState(0);
  const [lignes, setLignes] = useState<Ligne[]>([{designation:"",quantite:1,prix_unitaire:0,taux_tva:20}]);
 
  // OCR
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrData, setOcrData]       = useState<OcrData|null>(null);
  const [originalFile, setOriginalFile] = useState<File|null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
 
  const load = async () => {
    setLoading(true);
    const [{data:f},{data:c}] = await Promise.all([
      supabase.from("factures").select("*").eq("dossier_id",dossierId).order("date_facture",{ascending:false}),
      supabase.from("clients").select("id,nom,ice,email").eq("dossier_id",dossierId).is("deleted_at",null).order("nom"),
    ]);
    setFactures((f??[]) as unknown as Facture[]);
    setClients((c??[]) as Client[]);
    setLoading(false);
  };
  useEffect(()=>{load();},[dossierId]);
 
  const ht  = lignes.reduce((s,l)=>s+l.quantite*l.prix_unitaire,0);
  const tva = lignes.reduce((s,l)=>s+l.quantite*l.prix_unitaire*l.taux_tva/100,0);
  const ttc = ht+tva;
 
  const setLigne=(i:number,f:keyof Ligne,v:any)=>
    setLignes(ls=>ls.map((l,j)=>j===i?{...l,[f]:v}:l));
 
  // Mise à jour automatique montant_restant quand ttc change
  useEffect(()=>{
    if(typeFacture==="standard") { setMontantPaye(0); setMontantRestant(ttc); }
    else if(typeFacture==="acompte") { setMontantRestant(Math.max(0,ttc-montantPaye)); }
  },[ttc,typeFacture]);
 
  const handleOcr = async (file: File) => {
    setOcrLoading(true); setOcrData(null); setOriginalFile(file);
    try {
      let extractedText=""; let image_base64:string|undefined; const mime_type=file.type||"application/octet-stream";
      const isPdf=file.type==="application/pdf"||file.name.toLowerCase().endsWith(".pdf");
      const isImage=file.type.startsWith("image/");
 
      if(isPdf) {
        const pdfjsLib=await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc=`https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
        const ab=await file.arrayBuffer();
        const pdf=await pdfjsLib.getDocument({data:ab}).promise;
        let fullText="";
        for(let i=1;i<=pdf.numPages;i++){
          const page=await pdf.getPage(i);
          const content=await page.getTextContent();
          // Reconstruction par Y
          const items=content.items as any[];
          let lastY=-1,lineText="";
          for(const item of items){
            const y=Math.round(item.transform[5]);
            if(lastY!==-1&&Math.abs(y-lastY)>3){fullText+=lineText.trimEnd()+"\n";lineText="";}
            lineText+=item.str+" ";lastY=y;
          }
          if(lineText.trim()) fullText+=lineText.trimEnd()+"\n";
        }
        extractedText=fullText.trim();
        // Si PDF image → vision
        if(extractedText.replace(/\s/g,"").length<50){
          const page=await pdf.getPage(1);
          const vp=page.getViewport({scale:2.0});
          const canvas=document.createElement("canvas");
          canvas.width=vp.width; canvas.height=vp.height;
          await page.render({canvasContext:canvas.getContext("2d")!,viewport:vp,canvas}).promise;
          image_base64=canvas.toDataURL("image/jpeg",0.8).split(",")[1];
          extractedText="";
        }
      } else if(isImage) {
        image_base64=await new Promise<string>((res,rej)=>{
          const r=new FileReader();
          r.onload=()=>{const full=r.result as string;res(full.includes(",")?full.split(",")[1]:full);};
          r.onerror=rej; r.readAsDataURL(file);
        });
      } else { extractedText=await file.text(); }
 
      const result=await ocrFn({data:{extracted_text:extractedText,image_base64,mime_type,dossier_id:dossierId}});
      const r=result.result as OcrData;
      setOcrData(r);
 
      // Pré-remplir formulaire
      if(r.client_id) setClientId(r.client_id);
      if(r.numero_facture) setNumero(r.numero_facture);
      if(r.date_facture) setDateF(r.date_facture);
      if(r.date_echeance) setDateE(r.date_echeance);
      else {
        const d=new Date(r.date_facture||dateF);
        d.setDate(d.getDate()+30);
        setDateE(d.toISOString().slice(0,10));
      }
      if(r.mode_reglement) setModeReglement(r.mode_reglement);
      setTypeFacture(r.type_facture??"standard");
 
      // Montants selon type
      if(r.type_facture==="acompte") {
        setMontantPaye(r.montant_ttc??0);
        setMontantRestant(r.montant_restant_du??0);
      } else {
        setMontantPaye(0);
        setMontantRestant(r.montant_ttc??0);
      }
 
      if(r.lignes?.length) setLignes(r.lignes);
 
      if(r.client_action==="created"){await load();toast.success(`Client "${r.client_nom_extrait}" créé`);}
      else if(r.client_action==="found") toast.success(`Client "${r.client_trouve?.nom}" identifié`);
      else toast.warning("Client non identifié — sélectionnez manuellement");
 
    } catch(e:any){toast.error("Erreur OCR: "+e.message);}
    finally{setOcrLoading(false);}
  };
 
  const handleCreate = async () => {
    if(!clientId) return toast.error("Sélectionnez un client");
    if(!lignes[0].designation) return toast.error("Ajoutez au moins une ligne");
    const {data:authData}=await supabase.auth.getUser();
    const statut_paiement=montantPaye>=ttc?"payee":montantPaye>0?"partielle":"non_payee";
    const {data:newFact,error}=await (supabase.from("factures") as any).insert({
      dossier_id:dossierId,client_id:clientId,numero:numero||null,
      date_facture:dateF,date_echeance:dateE||null,
      lignes:lignes as any,montant_ht:ht,montant_tva:tva,montant_ttc:ttc,
      type_facture:typeFacture,
      montant_paye:montantPaye,
      montant_restant:montantRestant||ttc,
      mode_reglement:modeReglement||null,
      statut:"brouillon",statut_paiement,
      created_by:authData?.user?.id??null,
    }).select().single();
    if(error) return toast.error(error.message);
 
    if(originalFile&&newFact){
      const ext=originalFile.name.split(".").pop();
      const path=`${dossierId}/${newFact.id}.${ext}`;
      const{data:uploadData}=await supabase.storage.from("factures-originales").upload(path,originalFile,{upsert:true});
      if(uploadData){
        const{data:urlData}=supabase.storage.from("factures-originales").getPublicUrl(path);
        await (supabase.from("factures") as any).update({
          fichier_original_url:urlData?.publicUrl??null,
          fichier_original_nom:originalFile.name,
          fichier_original_type:originalFile.type,
        }).eq("id",newFact.id);
      }
    }
 
    toast.success("Facture créée");
    setOpenCreate(false);
    resetForm();
    load();
  };
 
  const resetForm=()=>{
    setOcrData(null);setOriginalFile(null);
    setLignes([{designation:"",quantite:1,prix_unitaire:0,taux_tva:20}]);
    setClientId("");setNumero("");setDateE("");setTypeFacture("standard");
    setMontantPaye(0);setMontantRestant(0);setModeReglement("virement");
  };
 
  const handleDelete = async (factureId: string) => {
    try {
      await supabase.from("ecritures_comptables").delete().eq("facture_id",factureId);
      const{error}=await supabase.from("factures").delete().eq("id",factureId);
      if(error) throw error;
      toast.success("Facture supprimée");
      setDeleteConfirm(null);
      load();
    } catch(e:any){toast.error(e.message);}
  };
 
  const handleGenXml = async (f: Facture) => {
    const client=clients.find(c=>c.id===f.client_id);
    if(!client?.email){setEmailModal({clientId:f.client_id!,factureId:f.id});toast.warning("Email client manquant");return;}
    setProcessing(f.id);
    try{
      const res=await genXml({data:{facture_id:f.id}});
      setDgiResult(res);
      if(res.conforme) toast.success("✅ Facture conforme DGI");
      else toast.error("❌ Facture rejetée");
      load();
    }catch(e:any){toast.error(e.message);}
    finally{setProcessing(null);}
  };
 
  const handleGenXmlSansEmail = async (fid: string) => {
    setProcessing(fid);setEmailModal(null);
    try{
      const res=await genXml({data:{facture_id:fid}});
      setDgiResult(res);
      if(res.conforme) toast.success("✅ Facture conforme DGI (sans email)");
      else toast.error("❌ Facture rejetée");
      load();
    }catch(e:any){toast.error(e.message);}
    finally{setProcessing(null);}
  };
 
  const handleAddEmail = async () => {
    if(!emailModal||!emailInput) return;
    try{
      await addEmailFn({data:{client_id:emailModal.clientId,email:emailInput}});
      toast.success("Email ajouté");
      await load();
      const f=factures.find(f=>f.id===emailModal.factureId);
      if(f){setEmailModal(null);setEmailInput("");handleGenXmlSansEmail(f.id);}
    }catch(e:any){toast.error(e.message);}
  };
 
  const handlePay = async (fid: string) => {
    setProcessing(fid);
    try{
      await payFn({data:{facture_id:fid,date_paiement:new Date().toISOString().slice(0,10)}});
      toast.success("Facture payée + écriture créée");
      load();
    }catch(e:any){toast.error(e.message);}
    finally{setProcessing(null);}
  };
 
  // KPIs
  const conformes  = factures.filter(f=>f.statut==="conforme");
  const caHT       = conformes.reduce((s,f)=>s+Number(f.montant_ht),0);
  const encours    = conformes.filter(f=>f.statut_paiement!=="payee").reduce((s,f)=>s+Number(f.montant_restant||f.montant_ttc),0);
  const enAnalyse  = factures.filter(f=>f.statut==="envoyee"||f.statut_dgi==="en_analyse").length;
 
  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Factures clients</h1>
          <p className="text-muted-foreground mt-1">E-facture DGI · XML UBL 2.1 · SHA-256</p>
        </div>
        <Dialog open={openCreate} onOpenChange={v=>{setOpenCreate(v);if(!v) resetForm();}}>
          <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-2"/>Nouvelle facture</Button></DialogTrigger>
          <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Créer une facture</DialogTitle></DialogHeader>
 
            <div className="grid grid-cols-2 gap-6">
              {/* Gauche: Upload OCR */}
              <div className="space-y-4">
                <h3 className="font-semibold text-sm">📄 Scan OCR (optionnel)</h3>
                <div className="border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:border-primary transition-colors"
                  onClick={()=>fileRef.current?.click()}
                  onDragOver={e=>e.preventDefault()}
                  onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)handleOcr(f);}}>
                  <input ref={fileRef} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg"
                    onChange={e=>{const f=e.target.files?.[0];if(f)handleOcr(f);}}/>
                  {ocrLoading
                    ?<><Loader2 className="h-8 w-8 animate-spin mx-auto text-primary mb-2"/><p className="text-sm">Extraction IA en cours…</p></>
                    :<><Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-50"/><p className="text-sm font-medium">Glissez une facture PDF / image</p><p className="text-xs text-muted-foreground mt-1">Extraction automatique des données</p></>
                  }
                </div>
 
                {ocrData && (
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant={ocrData.confidence==="high"?"default":"secondary"}>Confiance: {ocrData.confidence}</Badge>
                      {ocrData.client_action==="created"&&<Badge className="bg-blue-100 text-blue-700"><UserPlus className="h-3 w-3 mr-1"/>Client créé</Badge>}
                      {ocrData.client_action==="found"&&<Badge className="bg-green-100 text-green-700"><CheckCircle2 className="h-3 w-3 mr-1"/>Client identifié</Badge>}
                      {ocrData.client_action==="not_found"&&<Badge className="bg-yellow-100 text-yellow-700"><AlertCircle className="h-3 w-3 mr-1"/>Client non trouvé</Badge>}
                    </div>
                    <div className="p-3 bg-muted/50 rounded-lg space-y-1 text-xs">
                      <p><span className="text-muted-foreground">Émetteur:</span> {ocrData.emetteur_nom||"—"}</p>
                      <p><span className="text-muted-foreground">Client détecté:</span> <strong>{ocrData.client_nom_extrait||"Non détecté"}</strong></p>
                      <p><span className="text-muted-foreground">ICE client:</span> {ocrData.ice_client||"—"}</p>
                      <p><span className="text-muted-foreground">Sens:</span> {ocrData.sens_facture}</p>
                      {ocrData.type_facture!=="standard"&&(
                        <p><span className="text-muted-foreground">Type:</span> <Badge className="text-xs bg-blue-100 text-blue-700">{ocrData.type_facture}</Badge></p>
                      )}
                    </div>
 
                    {/* Lignes détectées */}
                    {ocrData.lignes?.length>0&&(
                      <div className="rounded border overflow-hidden">
                        <Table>
                          <TableHeader><TableRow><TableHead className="text-xs">Désignation</TableHead><TableHead className="text-xs">Qté</TableHead><TableHead className="text-xs">PU HT</TableHead><TableHead className="text-xs">TVA</TableHead></TableRow></TableHeader>
                          <TableBody>
                            {ocrData.lignes.map((l,i)=>(
                              <TableRow key={i}><TableCell className="text-xs">{l.designation}</TableCell><TableCell className="text-xs">{l.quantite}</TableCell><TableCell className="text-xs">{fmt(l.prix_unitaire)}</TableCell><TableCell className="text-xs">{l.taux_tva}%</TableCell></TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )}
              </div>
 
              {/* Droite: Formulaire éditable */}
              <div className="space-y-4">
                <h3 className="font-semibold text-sm">✏️ Données de la facture</h3>
 
                <div className="space-y-2">
                  <Label>Client *</Label>
                  <Select value={clientId} onValueChange={setClientId}>
                    <SelectTrigger><SelectValue placeholder="Sélectionner…"/></SelectTrigger>
                    <SelectContent>{clients.map(c=><SelectItem key={c.id} value={c.id}>{c.nom}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
 
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2"><Label>N° Facture</Label><Input value={numero} onChange={e=>setNumero(e.target.value)} placeholder="FA-001"/></div>
                  <div className="space-y-2">
                    <Label>Type</Label>
                    <Select value={typeFacture} onValueChange={v=>{setTypeFacture(v);if(v==="standard"){setMontantPaye(0);setMontantRestant(ttc);}}}>
                      <SelectTrigger><SelectValue/></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="acompte">Acompte</SelectItem>
                        <SelectItem value="solde">Solde</SelectItem>
                        <SelectItem value="avoir">Avoir</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2"><Label>Date facture</Label><Input type="date" value={dateF} onChange={e=>setDateF(e.target.value)}/></div>
                  <div className="space-y-2"><Label>Date échéance (défaut +30j)</Label><Input type="date" value={dateE} onChange={e=>setDateE(e.target.value)}/></div>
                </div>
 
                <div className="space-y-2">
                  <Label>Mode de règlement</Label>
                  <Select value={modeReglement} onValueChange={setModeReglement}>
                    <SelectTrigger><SelectValue/></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="virement">Virement bancaire</SelectItem>
                      <SelectItem value="cheque">Chèque</SelectItem>
                      <SelectItem value="especes">Espèces</SelectItem>
                      <SelectItem value="traite">Traite</SelectItem>
                      <SelectItem value="autre">Autre</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
 
                {/* Lignes */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label>Lignes</Label>
                    <Button type="button" variant="outline" size="sm" onClick={()=>setLignes(ls=>[...ls,{designation:"",quantite:1,prix_unitaire:0,taux_tva:20}])}>
                      <Plus className="h-3 w-3 mr-1"/>Ligne
                    </Button>
                  </div>
                  {lignes.map((l,i)=>(
                    <div key={i} className="grid grid-cols-12 gap-1 items-center mb-1">
                      <Input className="col-span-5 text-xs" placeholder="Désignation" value={l.designation} onChange={e=>setLigne(i,"designation",e.target.value)}/>
                      <Input className="col-span-2 text-xs" type="number" placeholder="Qté" value={l.quantite} onChange={e=>setLigne(i,"quantite",+e.target.value)}/>
                      <Input className="col-span-2 text-xs" type="number" placeholder="PU HT" value={l.prix_unitaire} onChange={e=>setLigne(i,"prix_unitaire",+e.target.value)}/>
                      <Select value={String(l.taux_tva)} onValueChange={v=>setLigne(i,"taux_tva",+v)}>
                        <SelectTrigger className="col-span-2 text-xs"><SelectValue/></SelectTrigger>
                        <SelectContent>{[0,7,10,14,20].map(r=><SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                      </Select>
                      <Button type="button" variant="ghost" size="icon" className="col-span-1" onClick={()=>setLignes(ls=>ls.filter((_,j)=>j!==i))} disabled={lignes.length===1}><X className="h-3 w-3"/></Button>
                    </div>
                  ))}
                  <div className="p-2 bg-muted rounded text-xs text-right mt-1">
                    HT: {fmt(ht)} · TVA: {fmt(tva)} · <strong>TTC: {fmt(ttc)}</strong>
                  </div>
                </div>
 
                {/* Montants payé / restant */}
                <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 space-y-3">
                  <p className="text-xs font-semibold text-blue-700">Suivi du paiement</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Montant payé (MAD)</Label>
                      <Input type="number" step="0.01" value={montantPaye}
                        onChange={e=>{const p=parseFloat(e.target.value)||0;setMontantPaye(p);setMontantRestant(Math.max(0,ttc-p));}}
                        className="text-sm font-mono"/>
                      <p className="text-[10px] text-muted-foreground">0 si non encore payée</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Montant restant dû (MAD)</Label>
                      <Input type="number" step="0.01" value={montantRestant}
                        onChange={e=>setMontantRestant(parseFloat(e.target.value)||0)}
                        className="text-sm font-mono"/>
                      <p className="text-[10px] text-muted-foreground">Calculé automatiquement</p>
                    </div>
                  </div>
                  <div className="text-xs text-blue-700">
                    Statut: <strong>{montantPaye>=ttc?"✅ Payée":montantPaye>0?"🔵 Paiement partiel":"⏳ En attente"}</strong>
                  </div>
                </div>
              </div>
            </div>
 
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={()=>{setOpenCreate(false);resetForm();}}>Annuler</Button>
              <Button onClick={handleCreate}>Créer la facture</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
 
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          {label:"CA HT (conformes DGI)",value:fmt(caHT),color:"text-green-600"},
          {label:"Encours clients",value:fmt(encours),color:"text-blue-600"},
          {label:"En analyse DGI",value:String(enAnalyse),color:"text-yellow-600"},
          {label:"Conformes",value:String(conformes.length),color:"text-green-600"},
        ].map(k=>(
          <Card key={k.label}><CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className={`text-xl font-bold mt-1 ${k.color}`}>{k.value}</p>
          </CardContent></Card>
        ))}
      </div>
 
      {/* Table */}
      <Card><CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>N°</TableHead><TableHead>Client</TableHead><TableHead>Date</TableHead>
              <TableHead>TTC</TableHead><TableHead>Payé</TableHead><TableHead>Restant</TableHead>
              <TableHead>DGI</TableHead><TableHead>Paiement</TableHead><TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ?<TableRow><TableCell colSpan={9} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto"/></TableCell></TableRow>
              :factures.length===0
              ?<TableRow><TableCell colSpan={9} className="text-center py-10 text-muted-foreground">Aucune facture</TableCell></TableRow>
              :factures.map(f=>(
                <TableRow key={f.id}>
                  <TableCell className="font-mono text-xs">{f.numero??f.id.slice(0,8)}</TableCell>
                  <TableCell className="text-sm">
                    <div>
                      {clients.find(c=>c.id===f.client_id)?.nom??"—"}
                      {!clients.find(c=>c.id===f.client_id)?.email&&f.client_id&&(
                        <span className="ml-2 text-xs text-orange-500 flex items-center gap-1"><Mail className="h-3 w-3"/>Email manquant</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{new Date(f.date_facture).toLocaleDateString("fr-MA")}</TableCell>
                  <TableCell className="font-medium text-sm">{fmt(Number(f.montant_ttc))}</TableCell>
                  <TableCell className="font-mono text-sm text-green-600">{fmt(Number(f.montant_paye??0))}</TableCell>
                  <TableCell className="font-mono text-sm text-orange-600">{fmt(Number(f.montant_restant??f.montant_ttc))}</TableCell>
                  <TableCell><DGIBadge statut={f.statut} statut_dgi={f.statut_dgi}/></TableCell>
                  <TableCell><StatutPaiementBadge f={f}/></TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {f.statut==="brouillon"&&(
                        <Button size="sm" variant="outline" disabled={processing===f.id} onClick={()=>handleGenXml(f)}>
                          {processing===f.id?<Loader2 className="h-3 w-3 animate-spin mr-1"/>:<FileCode className="h-3 w-3 mr-1"/>}e-Facture
                        </Button>
                      )}
                      {f.statut==="conforme"&&f.statut_paiement!=="payee"&&(
                        <Button size="sm" variant="outline" disabled={processing===f.id} onClick={()=>handlePay(f.id)}>
                          <CheckCircle className="h-3 w-3 mr-1"/>Payée
                        </Button>
                      )}
                      {f.xml_ubl&&(
                        <Button size="sm" variant="ghost" onClick={()=>setViewXml(f)} title="Voir XML"><Eye className="h-3 w-3"/></Button>
                      )}
                      {f.fichier_original_url&&(
                        <Button size="sm" variant="ghost" onClick={()=>window.open(f.fichier_original_url!,"_blank")} title="Voir original"><FileText className="h-3 w-3"/></Button>
                      )}
                      <Button size="sm" variant="ghost" className="text-red-500 hover:text-red-700" onClick={()=>setDeleteConfirm(f.id)}>
                        <Trash2 className="h-3 w-3"/>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent></Card>
 
      {/* Modal email manquant */}
      <Dialog open={!!emailModal} onOpenChange={()=>{setEmailModal(null);setEmailInput("");}}>
        <DialogContent>
          <DialogHeader><DialogTitle>Email client manquant</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Ajoutez l'email ou continuez sans envoi.</p>
            <div className="space-y-2"><Label>Email du client</Label>
              <Input type="email" placeholder="client@exemple.ma" value={emailInput} onChange={e=>setEmailInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")handleAddEmail();}}/>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={()=>emailModal&&handleGenXmlSansEmail(emailModal.factureId)}>Continuer sans email</Button>
            <Button onClick={handleAddEmail} disabled={!emailInput}><Mail className="h-4 w-4 mr-2"/>Ajouter et envoyer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
 
      {/* Modal confirmation suppression */}
      <Dialog open={!!deleteConfirm} onOpenChange={()=>setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Supprimer la facture ?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Cette action supprimera la facture et ses écritures comptables associées. Cette action est irréversible.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={()=>setDeleteConfirm(null)}>Annuler</Button>
            <Button variant="destructive" onClick={()=>deleteConfirm&&handleDelete(deleteConfirm)}>
              <Trash2 className="h-4 w-4 mr-2"/>Supprimer définitivement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
 
      {/* DGI Result */}
      <Dialog open={!!dgiResult} onOpenChange={()=>setDgiResult(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dgiResult?.conforme?"✅ Facture conforme DGI":"❌ Facture rejetée"}</DialogTitle></DialogHeader>
          {dgiResult&&(
            <div className={`p-4 rounded-lg text-sm space-y-2 ${dgiResult.conforme?"bg-green-50":"bg-red-50"}`}>
              <p>{dgiResult.dgi_response?.message}</p>
              {dgiResult.dgi_uuid&&<p className="font-mono text-xs break-all">UUID DGI: {dgiResult.dgi_uuid}</p>}
              {dgiResult.hash&&<p className="font-mono text-xs break-all">SHA-256: {dgiResult.hash.slice(0,32)}…</p>}
              {dgiResult.email_sent&&<p className="text-xs text-green-600">📧 Email envoyé au client</p>}
              {dgiResult.dgi_response?.erreurs?.length>0&&(
                <ul>{dgiResult.dgi_response.erreurs.map((e:string,i:number)=><li key={i} className="text-red-600 text-xs">• {e}</li>)}</ul>
              )}
              {dgiResult.conforme&&<p className="text-xs text-muted-foreground border-t pt-2">✅ Écritures comptables créées · Document archivé en GED</p>}
            </div>
          )}
          <DialogFooter><Button onClick={()=>setDgiResult(null)}>Fermer</Button></DialogFooter>
        </DialogContent>
      </Dialog>
 
      {/* XML Viewer */}
      <Dialog open={!!viewXml} onOpenChange={()=>setViewXml(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>XML UBL 2.1 — {viewXml?.numero}</DialogTitle></DialogHeader>
          <Button size="sm" variant="outline" className="w-fit" onClick={()=>{
            const blob=new Blob([viewXml!.xml_ubl!],{type:"application/xml"});
            const a=document.createElement("a");a.href=URL.createObjectURL(blob);
            a.download=`${viewXml!.numero??viewXml!.id}.xml`;a.click();
          }}><Download className="h-4 w-4 mr-1"/>Télécharger XML</Button>
          <pre className="bg-muted p-4 rounded text-xs overflow-auto max-h-96 font-mono whitespace-pre-wrap">{viewXml?.xml_ubl}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}


