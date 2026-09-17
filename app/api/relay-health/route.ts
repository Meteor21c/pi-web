import packageJson from "@/package.json";

/** No account details. Used only to identify a ready local launcher service. */
export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? packageJson.version;

export async function GET() {
  return Response.json({ product: "MeteorAgent", status: "ok", version: CURRENT_VERSION }, {
    headers: { "Cache-Control": "no-store" },
  });
}
