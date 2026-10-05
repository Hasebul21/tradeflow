import { ErrorState } from "@/components/ui/states";

export default function NotFound() {
  return <ErrorState title="Page not found" message="There is no page at this address. Use the menu above." />;
}
