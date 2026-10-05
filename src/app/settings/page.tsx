import { loadProfile } from "@/lib/profile";
import { SettingsView } from "./view";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  return <SettingsView profile={await loadProfile()} />;
}
