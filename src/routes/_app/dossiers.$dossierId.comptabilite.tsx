import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { BookOpen } from "lucide-react";

export const Route = createFileRoute("/_app/dossiers/$dossierId/comptabilite")({ component: ComptaPage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

function ComptaPage() {
  const { dossierId } = Route.useParams();
  const [ecritures, setEcritures] = useState<any[]>([]);
  const [comptes, setComptes] = useState<any[]>([]);
  const [filterCompte, setFilterCompte] = useState("");
  const [tab, setTab] = useState("balance");

  useEffect(() => {
    Promise.all([
      supabase.from("ecritures_comptables").select("*").eq("dossier_id", dossierId).order("date_ecriture", { ascending: false }),
      supabase.from("comptes_comptables").select("*").eq("dossier_id", dossierId).order("numero"),
    ]).then(([{ data: e }, { data: c }]) => {
      setEcritures((e ?? []) as any[]);
      setComptes((c ?? []) as any[]);
    });
  }, [dossierId]);

  // Balance: aggregate by compte_numero
  const balanceMap: Record<string, { intitule: string; debit: number; credit: number }> = {};
  for (const e of ecritures) {
    const num = e.compte_numero ?? "?";
    const cpte = comptes.find(c => c.numero === num);
    if (!balanceMap[num]) balanceMap[num] = { intitule: cpte?.intitule ?? num, debit: 0, credit: 0 };
    balanceMap[num].debit += Number(e.debit);
    balanceMap[num].credit += Number(e.credit);
  }
  const balance = Object.entries(balanceMap)
    .map(([numero, v]) => ({ numero, ...v, solde: v.debit - v.credit }))
    .sort((a, b) => a.numero.localeCompare(b.numero));

  const totalDebit = balance.reduce((s, r) => s + r.debit, 0);
  const totalCredit = balance.reduce((s, r) => s + r.credit, 0);

  const filteredEcritures = filterCompte
    ? ecritures.filter(e => (e.compte_numero ?? "").includes(filterCompte) || (e.journal_code ?? "").includes(filterCompte.toUpperCase()))
    : ecritures;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">Comptabilité</h1>
      <p className="text-muted-foreground mb-6">Plan Comptable Marocain (PCM) · Grand Livre · Balance</p>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="balance">Balance</TabsTrigger>
          <TabsTrigger value="grandlivre">Grand Livre</TabsTrigger>
          <TabsTrigger value="comptes">Plan de comptes</TabsTrigger>
        </TabsList>

        <TabsContent value="balance" className="mt-4">
          {balance.length === 0 ? (
            <Card><CardContent className="py-16 text-center text-muted-foreground">
              <BookOpen className="h-12 w-12 mx-auto mb-3 opacity-30" />
              Aucune écriture. Les écritures sont créées automatiquement lors de la validation des factures.
            </CardContent></Card>
          ) : (
            <Card><CardContent className="p-0">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Compte</TableHead><TableHead>Intitulé</TableHead>
                  <TableHead className="text-right">Débit</TableHead><TableHead className="text-right">Crédit</TableHead><TableHead className="text-right">Solde</TableHead><TableHead>S</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {balance.map(r => (
                    <TableRow key={r.numero}>
                      <TableCell className="font-mono text-sm font-bold">{r.numero}</TableCell>
                      <TableCell>{r.intitule}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(r.debit)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(r.credit)}</TableCell>
                      <TableCell className={`text-right font-mono text-sm font-medium ${r.solde >= 0 ? "text-green-600" : "text-red-600"}`}>{fmt(Math.abs(r.solde))}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{r.solde >= 0 ? "D" : "C"}</Badge></TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-bold bg-muted/50">
                    <TableCell colSpan={2}>TOTAL</TableCell>
                    <TableCell className="text-right font-mono">{fmt(totalDebit)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(totalCredit)}</TableCell>
                    <TableCell className={`text-right font-mono ${Math.abs(totalDebit - totalCredit) < 0.01 ? "text-green-600" : "text-red-600"}`}>{fmt(Math.abs(totalDebit - totalCredit))}</TableCell>
                    <TableCell>{Math.abs(totalDebit - totalCredit) < 0.01 ? <Badge className="text-xs bg-green-600">Équilibrée</Badge> : <Badge variant="destructive" className="text-xs">Déséquilibrée</Badge>}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="grandlivre" className="mt-4">
          <Input className="mb-4 max-w-xs" placeholder="Filtrer par compte ou journal…" value={filterCompte} onChange={e => setFilterCompte(e.target.value)} />
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Date</TableHead><TableHead>Journal</TableHead><TableHead>Compte</TableHead>
                <TableHead>Libellé</TableHead><TableHead className="text-right">Débit</TableHead><TableHead className="text-right">Crédit</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {filteredEcritures.length === 0
                  ? <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Aucune écriture</TableCell></TableRow>
                  : filteredEcritures.map(e => (
                    <TableRow key={e.id}>
                      <TableCell className="text-sm">{new Date(e.date_ecriture).toLocaleDateString("fr-MA")}</TableCell>
                      <TableCell><Badge variant="outline" className="font-mono text-xs">{e.journal_code}</Badge></TableCell>
                      <TableCell className="font-mono text-sm font-bold">{e.compte_numero}</TableCell>
                      <TableCell className="text-sm max-w-[200px] truncate">{e.libelle}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{Number(e.debit) > 0 ? fmt(Number(e.debit)) : ""}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{Number(e.credit) > 0 ? fmt(Number(e.credit)) : ""}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="comptes" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>N°</TableHead><TableHead>Intitulé</TableHead><TableHead>Type</TableHead></TableRow></TableHeader>
              <TableBody>
                {comptes.length === 0
                  ? <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">PCM non initialisé</TableCell></TableRow>
                  : comptes.map(c => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-sm font-bold">{c.numero}</TableCell>
                      <TableCell>{c.intitule}</TableCell>
                      <TableCell><Badge variant="secondary" className="text-xs">{c.type_compte}</Badge></TableCell>
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
