"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "../../../lib/api";
import ViloDateInput from "../../../components/ViloDateInput";
import { formatViloDate } from "../../../lib/dateFormat";

const initialForm = { case_id: "", client_id: "", description: "", category: "", amount: "", expense_date: "", billable: true };

export default function ExpensesPage() {
  const [items, setItems] = useState([]);
  const [cases, setCases] = useState([]);
  const [clients, setClients] = useState([]);
  const [form, setForm] = useState(initialForm);

  async function load() {
    const [e, c, cl] = await Promise.all([apiRequest('/api/v1/expenses'), apiRequest('/api/v1/cases'), apiRequest('/api/v1/clients')]);
    setItems(e); setCases(c); setClients(cl);
  }
  useEffect(() => { load(); }, []);

  async function submit(ev) {
    ev.preventDefault();
    await apiRequest('/api/v1/expenses', { method: 'POST', body: JSON.stringify({ ...form, case_id: form.case_id?Number(form.case_id):null, client_id: form.client_id?Number(form.client_id):null, amount: Number(form.amount) }) });
    setForm(initialForm); await load();
  }

  return <section className="dashboard-page-stack">
    <div className="dashboard-page-heading"><h1>Expenses</h1></div>
    <article className="dashboard-card vilo-form-card"><div className="dashboard-card__header"><h2>Create Expense</h2></div>
      <form className="vilo-form-grid" onSubmit={submit}>
        <div className="vilo-form-row-two">
          <select value={form.case_id} onChange={(e)=>setForm({...form,case_id:e.target.value})}><option value="">Case (optional)</option>{cases.map((c)=><option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <select value={form.client_id} onChange={(e)=>setForm({...form,client_id:e.target.value})}><option value="">Client (optional)</option>{clients.map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </div>
        <input placeholder="Category" value={form.category} onChange={(e)=>setForm({...form,category:e.target.value})}/>
        <textarea placeholder="Description" value={form.description} onChange={(e)=>setForm({...form,description:e.target.value})} required/>
        <div className="vilo-form-row-two">
          <input type="number" step="0.01" placeholder="Amount" value={form.amount} onChange={(e)=>setForm({...form,amount:e.target.value})} required/>
          <ViloDateInput value={form.expense_date} onChange={(value)=>setForm({...form,expense_date:value})} required/>
        </div>
        <label><input type="checkbox" checked={form.billable} onChange={(e)=>setForm({...form,billable:e.target.checked})}/> Billable</label>
        <button type="submit">Add Expense</button>
      </form>
    </article>
    <article className="dashboard-card vilo-table-card"><div className="dashboard-card__header"><h2>Expenses</h2></div><div className="vilo-table-wrap"><table className="team-table"><thead><tr><th>Description</th><th>Amount</th><th>Date</th><th>Billed</th></tr></thead><tbody>{items.map((x)=><tr key={x.id}><td>{x.description}</td><td>{x.amount}</td><td>{formatViloDate(x.expense_date)}</td><td><span className={`vilo-badge ${x.billed?'vilo-badge--completed':'vilo-badge--pending'}`}>{x.billed?'billed':'unbilled'}</span></td></tr>)}</tbody></table></div></article>
  </section>;
}
