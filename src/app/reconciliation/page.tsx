import { loadContributions } from "@/lib/data";
import { reconcile } from "@/lib/reconcile";
import { loadBankDeposits, loadBrokerStatement } from "@/lib/sources";
import { loadTransactions } from "@/lib/transactions";
import { ReconciliationView } from "./view";

export const dynamic = "force-dynamic";

export default async function ReconciliationPage() {
  const [broker, ledger, bank, contributions] = await Promise.all([
    loadBrokerStatement(),
    loadTransactions(),
    loadBankDeposits(),
    loadContributions(),
  ]);
  return <ReconciliationView r={reconcile({ broker, ledger, bank, contributions })} />;
}
