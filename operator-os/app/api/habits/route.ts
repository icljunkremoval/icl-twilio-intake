import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    message: "Use Supabase wiring for production persistence. Local mode uses browser storage.",
  });
}

export async function POST() {
  return NextResponse.json(
    { message: "POST habits endpoint placeholder. Connect to Supabase in Phase 1." },
    { status: 501 },
  );
}
