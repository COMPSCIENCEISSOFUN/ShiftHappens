/**
 * Root Page (Boundary Layer)
 *
 * Entry point of the application.
 * - Authenticated users → redirect to /dashboard
 * - Unauthenticated users → show the public landing page
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import LandingPage from "@/components/landing/landing-page";
import { FaqService } from "@/services/faq.service";
import { ReviewService } from "@/services/review.service";

export default async function Home() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  /*
   * Read here, not in the component.
   *
   * This page is already a server component, so the published entries can be
   * fetched while it renders and arrive with the HTML. A client fetch would
   * show an empty accordion for the length of a round trip on the first screen
   * a visitor ever sees — and would need a public endpoint, which is a thing to
   * rate limit and defend for content that changes twice a year.
   *
   * A failure here must not take the landing page down with it. An empty FAQ
   * renders as no section at all, which is the same thing a visitor sees before
   * the first entry is written.
   */
  let faq: Awaited<ReturnType<FaqService["getPublished"]>> = [];
  try {
    faq = await new FaqService().getPublished();
  } catch (error) {
    console.error("[Landing] could not load the FAQ", error);
  }

  /*
   * Reviews, read the same way and failing the same way.
   *
   * Flattened here rather than in the component: the landing page should not
   * know that an author is reached through a membership and then a user, and a
   * shape that mirrors the database is a shape that changes when the database
   * does.
   */
  let reviews: {
    id: string;
    rating: number;
    body: string;
    authorName: string | null;
    organizationName: string;
  }[] = [];
  try {
    reviews = (await new ReviewService().getPublished()).map((review) => ({
      id: review.id,
      rating: review.rating,
      body: review.body,
      authorName: review.membership.user.name,
      organizationName: review.organization.name,
    }));
  } catch (error) {
    console.error("[Landing] could not load reviews", error);
  }

  return <LandingPage faq={faq} reviews={reviews} />;
}
