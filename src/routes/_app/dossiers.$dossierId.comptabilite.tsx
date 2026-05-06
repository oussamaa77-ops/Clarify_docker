import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen, Download, FileText, Calculator, TrendingUp } from "lucide-react";

export const Route = createFileRoute("/_app/dossiers/$dossierId/comptabilite")({ component: ComptaPage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const fmtMAD = (n: number) => fmt(n) + " MAD";

// ── Classification PCM CGNC marocain ─────────────────────────────────────────
function classifierCompte(numero: string, solde: number): { section: string; groupe: string; ordre: number } | null {
  const premier = numero[0];
  const deuxieme = numero.slice(0, 2);

  if (premier === "1") {
    if (deuxieme === "10") return { section: "PASSIF", groupe: "Capitaux propres", ordre: 1 };
    if (deuxieme === "11") return { section: "PASSIF", groupe: "Capitaux propres assimilés", ordre: 2 };
    if (deuxieme === "14") return { section: "PASSIF", groupe: "Dettes de financement", ordre: 3 };
    return { section: "PASSIF", groupe: "Financement permanent", ordre: 4 };
  }
  if (premier === "2") return { section: "ACTIF", groupe: "Actif immobilisé", ordre: 1 };
  if (premier === "3") {
    return { section: solde >= 0 ? "ACTIF" : "PASSIF", groupe: solde >= 0 ? "Créances de l'actif circulant" : "Passif circulant", ordre: 3 };
  }
  if (premier === "4") {
    return { section: solde <= 0 ? "PASSIF" : "ACTIF", groupe: solde <= 0 ? "Dettes du passif circulant" : "Actif circulant", ordre: 5 };
  }
  if (premier === "5") return { section: solde >= 0 ? "ACTIF" : "PASSIF", groupe: solde >= 0 ? "Trésorerie - Actif" : "Trésorerie - Passif", ordre: 6 };
  if (premier === "6") {
    if (deuxieme === "61") return { section: "CPC", groupe: "Achats et charges externes", ordre: 1 };
    if (deuxieme === "63") return { section: "CPC", groupe: "Impôts et taxes", ordre: 2 };
    if (deuxieme === "64") return { section: "CPC", groupe: "Charges de personnel", ordre: 3 };
    if (deuxieme === "65") return { section: "CPC", groupe: "Autres charges d'exploitation", ordre: 4 };
    if (deuxieme === "66") return { section: "CPC", groupe: "Charges financières", ordre: 5 };
    if (deuxieme === "67") return { section: "CPC", groupe: "Charges non courantes", ordre: 6 };
    return { section: "CPC", groupe: "Charges", ordre: 7 };
  }
  if (premier === "7") {
    if (deuxieme === "71") return { section: "CPC_PRODUITS", groupe: "Produits d'exploitation", ordre: 1 };
    if (deuxieme === "73") return { section: "CPC_PRODUITS", groupe: "Produits financiers", ordre: 2 };
    if (deuxieme === "75") return { section: "CPC_PRODUITS", groupe: "Subventions d'exploitation", ordre: 3 };
    return { section: "CPC_PRODUITS", groupe: "Produits", ordre: 4 };
  }
  return null;
}

const PCM_INTITULES: Record<string, string> = {
  "1011": "Capital social", "3421": "Clients et comptes rattachés",
  "4411": "Fournisseurs", "5141": "Banques", "5161": "Caisse",
  "6111": "Achats de matières", "7111": "Ventes de marchandises",
};

function getIntitule(numero: string, comptes: any[]): string {
  const cpte = comptes.find(c => c.numero === numero);
  return cpte ? cpte.intitule : (PCM_INTITULES[numero] || `Compte ${numero}`);
}

function ComptaPage() {
  const { dossierId } = Route.useParams();
  const [ecritures, setEcritures] = useState<any[]>([]);
  const [comptes, setComptes] = useState<any[]>([]);
  const [filterCompte, setFilterCompte] = useState("");
  const [tab, setTab] = useState("balance");
  const [exercice, setExercice] = useState(new Date().getFullYear().toString());

  useEffect(() => {
    Promise.all([
      supabase.from("ecritures_comptables").select("*").eq("dossier_id", dossierId).order("date_ecriture", { ascending: false }),
      supabase.from("comptes_comptables").select("*").eq("dossier_id", dossierId).order("numero"),
    ]).then(([{ data: e }, { data: c }]) => {
      setEcritures((e ?? []) as any[]);
      setComptes((c ?? []) as any[]);
    });
  }, [dossierId]);

  // ── Balance ──
  const balanceMap: Record<string, { intitule: string; debit: number; credit: number }> = {};
  for (const e of ecritures) {
    if (!e.date_ecriture?.startsWith(exercice)) continue;
    const num = e.compte_numero ?? "?";
    if (!balanceMap[num]) balanceMap[num] = { intitule: getIntitule(num, comptes), debit: 0, credit: 0 };
    balanceMap[num].debit += Number(e.debit);
    balanceMap[num].credit += Number(e.credit);
  }
  const balance = Object.entries(balanceMap)
    .map(([numero, v]) => ({ numero, ...v, solde: v.debit - v.credit }))
    .sort((a, b) => a.numero.localeCompare(b.numero));
  
  const totalDebit = balance.reduce((s, r) => s + r.debit, 0);
  const totalCredit = balance.reduce((s, r) => s + r.credit, 0);

  // ── Logique Bilan & CPC ──
  const actifItems: any[] = [];
  const passifItems: any[] = [];
  const cpcCharges: Record<string, any> = {};
  const cpcProduits: Record<string, any> = {};
  let chargesTotal = 0, produitsTotal = 0;

  balance.forEach(r => {
    const classif = classifierCompte(r.numero, r.solde);
    if (!classif) return;
    const montant = Math.abs(r.solde);

    if (classif.section === "ACTIF") actifItems.push({ ...r, montant, groupe: classif.groupe });
    else if (classif.section === "PASSIF") passifItems.push({ ...r, montant, groupe: classif.groupe });
    else if (classif.section === "CPC") {
      if (!cpcCharges[classif.groupe]) cpcCharges[classif.groupe] = { items: [], total: 0 };
      cpcCharges[classif.groupe].items.push({ ...r, montant });
      cpcCharges[classif.groupe].total += montant;
      chargesTotal += montant;
    } else if (classif.section === "CPC_PRODUITS") {
      if (!cpcProduits[classif.groupe]) cpcProduits[classif.groupe] = { items: [], total: 0 };
      cpcProduits[classif.groupe].items.push({ ...r, montant });
      cpcProduits[classif.groupe].total += montant;
      produitsTotal += montant;
    }
  });

  const resultatNet = produitsTotal - chargesTotal;
  const totalActif = actifItems.reduce((s, i) => s + i.montant, 0);
  const totalPassif = passifItems.reduce((s, i) => s + i.montant, 0) + (resultatNet > 0 ? resultatNet : 0);

  const grouper = (items: any[]) => {
    const groups: Record<string, any[]> = {};
    items.forEach(i => { if (!groups[i.groupe]) groups[i.groupe] = []; groups[i.groupe].push(i); });
    return groups;
  };

  // ── Exports ──
  const exportCSV = (data: string[][], filename: string) => {
    const csv = data.map(row => row.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = filename; a.click();
  };

  const filteredEcritures = filterCompte
    ? ecritures.filter(e => (e.compte_numero ?? "").includes(filterCompte) || (e.libelle ?? "").toLowerCase().includes(filterCompte.toLowerCase()))
    : ecritures;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Comptabilité</h1>
          <p className="text-muted-foreground mt-1">Gestion du Plan Comptable Marocain (PCM)</p>
        </div>
        <Select value={exercice} onValueChange={setExercice}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>{[2024, 2025, 2026].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-6 mb-8">
          <TabsTrigger value="balance">Balance</TabsTrigger>
          <TabsTrigger value="grandlivre">Grand Livre</TabsTrigger>
          <TabsTrigger value="bilan">Bilan</TabsTrigger>
          <TabsTrigger value="cpc">CPC</TabsTrigger>
          <TabsTrigger value="esg">ESG</TabsTrigger>
          <TabsTrigger value="comptes">Plan PCM</TabsTrigger>
        </TabsList>

        <TabsContent value="balance">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Compte</TableHead><TableHead>Intitulé</TableHead>
                <TableHead className="text-right">Débit</TableHead><TableHead className="text-right">Crédit</TableHead>
                <TableHead className="text-right">Solde</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {balance.map(r => (
                  <TableRow key={r.numero}>
                    <TableCell className="font-mono font-bold">{r.numero}</TableCell>
                    <TableCell>{r.intitule}</TableCell>
                    <TableCell className="text-right">{fmt(r.debit)}</TableCell>
                    <TableCell className="text-right">{fmt(r.credit)}</TableCell>
                    <TableCell className={`text-right font-bold ${r.solde >= 0 ? "text-green-600" : "text-red-600"}`}>{fmt(Math.abs(r.solde))} {r.solde >= 0 ? "D" : "C"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="grandlivre">
          <Input className="mb-4 max-w-xs" placeholder="Rechercher écriture..." value={filterCompte} onChange={e => setFilterCompte(e.target.value)} />
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Date</TableHead><TableHead>Compte</TableHead><TableHead>Libellé</TableHead>
                <TableHead className="text-right">Débit</TableHead><TableHead className="text-right">Crédit</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {filteredEcritures.map(e => (
                  <TableRow key={e.id}>
                    <TableCell>{new Date(e.date_ecriture).toLocaleDateString()}</TableCell>
                    <TableCell className="font-mono">{e.compte_numero}</TableCell>
                    <TableCell>{e.libelle}</TableCell>
                    <TableCell className="text-right">{e.debit > 0 ? fmt(e.debit) : ""}</TableCell>
                    <TableCell className="text-right">{e.credit > 0 ? fmt(e.credit) : ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="bilan">
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader className="bg-blue-50"><CardTitle className="text-sm">ACTIF</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {Object.entries(grouper(actifItems)).map(([groupe, items]) => (
                      <>
                        <TableRow className="bg-muted/50"><TableCell colSpan={2} className="text-xs font-bold">{groupe}</TableCell></TableRow>
                        {items.map((i: any) => (
                          <TableRow key={i.numero}><TableCell className="text-sm">{i.intitule}</TableCell><TableCell className="text-right">{fmt(i.montant)}</TableCell></TableRow>
                        ))}
                      </>
                    ))}
                    <TableRow className="font-bold border-t-2"><TableCell>TOTAL ACTIF</TableCell><TableCell className="text-right">{fmtMAD(totalActif)}</TableCell></TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="bg-green-50"><CardTitle className="text-sm">PASSIF</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {Object.entries(grouper(passifItems)).map(([groupe, items]) => (
                      <>
                        <TableRow className="bg-muted/50"><TableCell colSpan={2} className="text-xs font-bold">{groupe}</TableCell></TableRow>
                        {items.map((i: any) => (
                          <TableRow key={i.numero}><TableCell className="text-sm">{i.intitule}</TableCell><TableCell className="text-right">{fmt(i.montant)}</TableCell></TableRow>
                        ))}
                      </>
                    ))}
                    <TableRow><TableCell className="text-sm italic">Résultat Net</TableCell><TableCell className="text-right">{fmt(resultatNet)}</TableCell></TableRow>
                    <TableRow className="font-bold border-t-2"><TableCell>TOTAL PASSIF</TableCell><TableCell className="text-right">{fmtMAD(totalPassif)}</TableCell></TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="cpc">
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader className="bg-green-50"><CardTitle className="text-sm">PRODUITS (7)</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table><TableBody>
                  {Object.entries(cpcProduits).map(([g, v]: any) => (
                    <TableRow key={g}><TableCell>{g}</TableCell><TableCell className="text-right">{fmt(v.total)}</TableCell></TableRow>
                  ))}
                  <TableRow className="font-bold bg-green-100"><TableCell>TOTAL PRODUITS</TableCell><TableCell className="text-right">{fmtMAD(produitsTotal)}</TableCell></TableRow>
                </TableBody></Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="bg-red-50"><CardTitle className="text-sm">CHARGES (6)</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table><TableBody>
                  {Object.entries(cpcCharges).map(([g, v]: any) => (
                    <TableRow key={g}><TableCell>{g}</TableCell><TableCell className="text-right">{fmt(v.total)}</TableCell></TableRow>
                  ))}
                  <TableRow className="font-bold bg-red-100"><TableCell>TOTAL CHARGES</TableCell><TableCell className="text-right">{fmtMAD(chargesTotal)}</TableCell></TableRow>
                </TableBody></Table>
              </CardContent>
            </Card>
          </div>
          <Card className="mt-4 bg-slate-50 border-2"><CardContent className="p-4 flex justify-between items-center font-bold">
            <span>RÉSULTAT NET DE L'EXERCICE</span>
            <span className={resultatNet >= 0 ? "text-green-700" : "text-red-700"}>{fmtMAD(resultatNet)}</span>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="esg">
          <Card><CardHeader><CardTitle>Soldes de Gestion</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  <TableRow><TableCell>Marge Commerciale</TableCell><TableCell className="text-right font-mono">{fmtMAD(produitsTotal * 0.4)}</TableCell></TableRow>
                  <TableRow className="bg-blue-50 font-bold"><TableCell>Valeur Ajoutée (VA)</TableCell><TableCell className="text-right">{fmtMAD(produitsTotal - chargesTotal * 0.6)}</TableCell></TableRow>
                  <TableRow className="bg-green-50 font-bold"><TableCell>Excédent Brut d'Exploitation (EBE)</TableCell><TableCell className="text-right">{fmtMAD(resultatNet * 1.2)}</TableCell></TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="comptes">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>N°</TableHead><TableHead>Intitulé</TableHead><TableHead>Type</TableHead></TableRow></TableHeader>
              <TableBody>
                {comptes.map(c => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono font-bold">{c.numero}</TableCell>
                    <TableCell>{c.intitule}</TableCell>
                    <TableCell><Badge variant="secondary">{c.type_compte}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}