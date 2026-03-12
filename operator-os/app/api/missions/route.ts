import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    message: "Missions API placeholder. Current mission state is local-first.",
  });
}

export async function POST() {
  return NextResponse.json(
    { message: "POST missions endpoint placeholder. Connect to Supabase in Phase 2." },
    { status: 501 },
  );
}
