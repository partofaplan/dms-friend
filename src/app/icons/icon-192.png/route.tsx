import { renderAppIcon } from "@/lib/pwa/app-icon";

export const dynamic = "force-static";

export function GET() {
  return renderAppIcon(192);
}
