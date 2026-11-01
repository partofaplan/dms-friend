import { renderPlaceholderIcon } from "@/lib/pwa/placeholder-icon";

export const dynamic = "force-static";

export function GET() {
  return renderPlaceholderIcon(192);
}
