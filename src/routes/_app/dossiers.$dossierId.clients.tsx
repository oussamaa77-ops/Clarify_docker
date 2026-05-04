import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Pencil, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/dossiers/$dossierId/clients")({ component: ClientsPage });

// Also exported for reuse in fournisseurs
export function TiersPage({ table, titre }: { table: "clients" | "fournisseurs"; titre: string }) {
  const { dossierId } = Route.useParams ? Route.useParams() : { dossierId: "" };
  return <ClientsPage />;
}

interface Tiers { id: string; nom: string; ice: string | null; if_fiscal: string | null; rc: string | null; email: string | null; telephone: string | null; adresse: string | null; }
const EMPTY = { nom: "", ice: "", if_fiscal: "", rc: "", email: "", telephone: "", adresse: "" };

function ClientsPage() {
  const { dossierId } = Route.useParams();
  const [items, setItems] = useState<Tiers[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Tiers | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from("clients").select("*").eq("dossier_id", dossierId).is("deleted_at", null).order("nom");
    setItems((data ?? []) as Tiers[]);
    setLoading(false);
  };
  useEffect(() => { load(); }, [dossierId]);

  const openCreate = () => { setEditing(null); setForm(EMPTY); setOpen(true); };
  const openEdit = (t: Tiers) => { setEditing(t); setForm({ nom: t.nom, ice: t.ice ?? "", if_fiscal: t.if_fiscal ?? "", rc: t.rc ?? "", email: t.email ?? "", telephone: t.telephone ?? "", adresse: t.adresse ?? "" }); setOpen(true); };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.nom) return toast.error("Nom requis");
    const payload = { ...form, ice: form.ice || null, if_fiscal: form.if_fiscal || null, rc: form.rc || null, email: form.email || null, telephone: form.telephone || null, adresse: form.adresse || null };
    const { error } = editing
      ? await supabase.from("clients").update(payload).eq("id", editing.id)
      : await supabase.from("clients").insert({ dossier_id: dossierId, ...payload });
    if (error) return toast.error(error.message);
    toast.success(editing ? "Client mis à jour" : "Client créé");
    setOpen(false);
    load();
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("clients").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Client supprimé");
    load();
  };

  const filtered = items.filter(t => t.nom.toLowerCase().includes(search.toLowerCase()) || (t.ice ?? "").includes(search) || (t.email ?? "").includes(search));

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Clients</h1>
          <p className="text-muted-foreground mt-1">{items.length} client{items.length !== 1 ? "s" : ""}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" />Nouveau client</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing ? "Modifier le client" : "Nouveau client"}</DialogTitle></DialogHeader>
            <form onSubmit={handleSave} className="space-y-3">
              <div className="space-y-2"><Label>Raison sociale *</Label><Input required value={form.nom} onChange={e => setForm({ ...form, nom: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>ICE</Label><Input value={form.ice} onChange={e => setForm({ ...form, ice: e.target.value })} placeholder="15 chiffres" /></div>
                <div className="space-y-2"><Label>IF</Label><Input value={form.if_fiscal} onChange={e => setForm({ ...form, if_fiscal: e.target.value })} /></div>
                <div className="space-y-2"><Label>RC</Label><Input value={form.rc} onChange={e => setForm({ ...form, rc: e.target.value })} /></div>
                <div className="space-y-2"><Label>Téléphone</Label><Input value={form.telephone} onChange={e => setForm({ ...form, telephone: e.target.value })} /></div>
              </div>
              <div className="space-y-2"><Label>Email</Label><Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
              <div className="space-y-2"><Label>Adresse</Label><Input value={form.adresse} onChange={e => setForm({ ...form, adresse: e.target.value })} /></div>
              <DialogFooter><Button variant="outline" type="button" onClick={() => setOpen(false)}>Annuler</Button><Button type="submit">{editing ? "Sauvegarder" : "Créer"}</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Input className="mb-4 max-w-sm" placeholder="Rechercher…" value={search} onChange={e => setSearch(e.target.value)} />

      <Card><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Nom</TableHead><TableHead>ICE</TableHead><TableHead>IF</TableHead><TableHead>Email</TableHead><TableHead>Tél</TableHead><TableHead></TableHead></TableRow></TableHeader>
          <TableBody>
            {loading ? <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Chargement…</TableCell></TableRow>
              : filtered.length === 0 ? <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground"><Users className="h-8 w-8 mx-auto mb-2 opacity-30" />Aucun client{search ? " trouvé" : ". Créez votre premier client."}</TableCell></TableRow>
              : filtered.map(t => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.nom}</TableCell>
                  <TableCell className="font-mono text-xs">{t.ice ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{t.if_fiscal ?? "—"}</TableCell>
                  <TableCell className="text-sm">{t.email ?? "—"}</TableCell>
                  <TableCell className="text-sm">{t.telephone ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" onClick={() => openEdit(t)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" onClick={() => handleDelete(t.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent></Card>
    </div>
  );
}
