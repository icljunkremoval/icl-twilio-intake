import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    message: "Wins API placeholder. Persisted locally until Supabase connection is added.",
  });
}

export async function POST() {
  return NextResponse.json(
    { message: "POST wins endpoint placeholder. Connect to Supabase in Phase 2." },
    { status: 501 },
  );
}
