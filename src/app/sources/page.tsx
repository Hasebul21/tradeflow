import { loadBankDeposits, loadBrokerStatement } from "@/lib/sources";
import { SourcesView } from "./view";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const [broker, bank] = await Promise.all([loadBrokerStatement(), loadBankDeposits()]);
  return <SourcesView broker={broker} bank={bank} />;
}
