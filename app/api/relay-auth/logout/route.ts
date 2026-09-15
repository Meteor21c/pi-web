import { NextResponse } from "next/server";
import { clearRelaySessionFile } from "@/lib/relay-auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearRelaySessionFile();
  return NextResponse.json({ ok: true });
}
