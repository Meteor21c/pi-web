/** No account details. Used only to identify a ready local launcher service. */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ product: "MeteorAgent", status: "ok" }, {
    headers: { "Cache-Control": "no-store" },
  });
}
