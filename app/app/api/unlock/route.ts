import { NextResponse, type NextRequest } from "next/server";
import {
  GATE_COOKIE,
  GATE_MAX_AGE,
  gatePassword,
  gateToken,
  safeNext,
  sameText,
} from "../../../lib/gate";

/** Form POST from /unlock. Success sets the gate cookie and returns to the
 * requested page; failure returns to the form after a short delay. */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const next = safeNext(form.get("next"));
  const attempt = form.get("password");
  const password = gatePassword();
  const ok =
    !!password &&
    typeof attempt === "string" &&
    attempt.length <= 256 &&
    sameText(await gateToken(attempt), await gateToken(password));
  if (!ok) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const back = new URL("/unlock", request.url);
    back.searchParams.set("next", next);
    back.searchParams.set("error", password ? "1" : "unset");
    return NextResponse.redirect(back, 303);
  }
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(GATE_COOKIE, await gateToken(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: GATE_MAX_AGE,
  });
  return response;
}
