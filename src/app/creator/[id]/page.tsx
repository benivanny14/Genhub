// =============================================================================
// GENHUB - Creator public profile page (SEO shell)
// Server component: fetches the creator for metadata + JSON-LD, 404s unknown
// ids, then hands off to the client profile component.
// =============================================================================

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import prisma from "@/lib/db";
import config from "@/lib/config";
import CreatorProfileClient from "./CreatorProfile";

interface Props {
  params: { id: string };
}

async function getCreator(id: string) {
  try {
    return await prisma.user.findFirst({
      where: { id, role: "CREATOR", isBanned: false },
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        isVerified: true,
        creatorProfile: { select: { bio: true, socialLinks: true } },
        _count: { select: { videos: { where: { isPublished: true, isDeleted: false } } } },
      },
    });
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const creator = await getCreator(params.id);
  if (!creator) return { title: "Creator not found" };

  const name = creator.displayName || "Creator";
  // Layout applies the "%s | Genhub" template — don't repeat the brand
  const title = `${name} — Creator`;
  const description =
    creator.creatorProfile?.bio ||
    `Watch ${creator._count.videos} video(s) from ${name} on Genhub. Uploads, subscriptions and exclusive content.`;
  const base = config.appUrl.replace(/\/$/, "");
  const url = `${base}/creator/${creator.id}`;
  const image =
    creator.avatarUrl || `https://picsum.photos/seed/genhub-creator-${creator.id}/1200/630`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "Genhub",
      type: "profile",
      images: [{ url: image, width: 1200, height: 630, alt: name }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}

export default async function CreatorPage({ params }: Props) {
  const creator = await getCreator(params.id);
  if (!creator) notFound();

  const name = creator.displayName || "Creator";
  const base = config.appUrl.replace(/\/$/, "");
  const url = `${base}/creator/${creator.id}`;
  const image =
    creator.avatarUrl || `https://picsum.photos/seed/genhub-creator-${creator.id}/1200/630`;

  const socials: string[] = Array.isArray(creator.creatorProfile?.socialLinks)
    ? (creator.creatorProfile!.socialLinks as unknown[]).filter(
        (s): s is string => typeof s === "string"
      )
    : [];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url,
    name: `${name} on Genhub`,
    mainEntity: {
      "@type": "Person",
      name,
      image,
      description: creator.creatorProfile?.bio || undefined,
      url,
      ...(socials.length ? { sameAs: socials } : {}),
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <CreatorProfileClient params={params} />
    </>
  );
}
