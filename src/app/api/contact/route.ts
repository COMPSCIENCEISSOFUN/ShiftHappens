import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const contactSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  company: z.string().trim().max(150).optional().or(z.literal("")),
  message: z.string().trim().min(10).max(3000),
}).strict();

export async function POST(request: NextRequest) {
  const parsed = contactSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please check your contact details and message." },
      { status: 400 }
    );
  }
  await prisma.contactSubmission.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      company: parsed.data.company || null,
      message: parsed.data.message,
    },
  });
  return NextResponse.json({ received: true }, { status: 201 });
}
