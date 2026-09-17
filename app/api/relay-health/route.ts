import packageJson from "@/package.json";
import { randomUUID } from "node:crypto";

/** No account details. Used only to identify a ready local launcher service. */
export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? packageJson.version;
// A browser can use this opaque, process-local value to distinguish a real
// service restart from a successful health response from the old process.
const INSTANCE_ID = randomUUID();

export async function GET() {
  return Response.json({ product: "MeteorAgent", status: "ok", version: CURRENT_VERSION, instanceId: INSTANCE_ID }, {
    headers: { "Cache-Control": "no-store" },
  });
}
