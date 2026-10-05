"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/ui/server-form";
import { saveProfile, validateProfile } from "@/lib/profile";

export async function saveSettings(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = validateProfile(Object.fromEntries(formData.entries()));
  if (!result.ok) return { error: result.error };
  await saveProfile(result.profile);
  revalidatePath("/settings");
  return { ok: "Settings saved." };
}
