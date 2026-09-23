// =============================================================================
// GENHUB - Video detail page (SEO shell)
// Server component: resolves the video by slug or id for metadata + VideoObject
// structured data, 404s unknown videos, then renders the client player page.
// =============================================================================

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import prisma from "@/lib/db";
import config from "@/lib/config";
import VideoDetailPage from "./VideoDetail";

interface Props {
  params: { id: string };
}

async function getVideo(id: string) {
  try {
    return await prisma.video.findFirst({
      where: {
        OR: [{ slug: id }, { id }],
        isPublished: true,
        isDeleted: false,
      },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        thumbnailUrl: true,
        price: true,
        duration: true,
        viewsCount: true,
        likesCount: true,
        category: true,
        isPremium: true,
        createdAt: true,
        creator: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
  } catch {
    return null;
  }
}

function isoDuration(seconds: number | null): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `PT${m}M${s}S`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const video = await getVideo(params.id);
  if (!video) return { title: "Video not found" };

  const creatorName = video.creator.displayName || "Creator";
  // Layout applies the "%s | Genhub" template — don't repeat the brand
  const title = `${video.title} — ${creatorName}`;
  const description =
    (video.description || "").slice(0, 155) ||
    `Watch "${video.title}" by ${creatorName} on Genhub.` +
      (video.price > 0 ? ` Unlock for TZS ${video.price.toLocaleString()}.` : " Free to watch.");
  const base = config.appUrl.replace(/\/$/, "");
  const url = `${base}/video/${video.slug || video.id}`;
  const image =
    video.thumbnailUrl ||
    `https://picsum.photos/seed/genhub-video-${video.id}/1200/630`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "Genhub",
      type: "video.other",
      videos: [{ url }],
      images: [{ url: image, width: 1200, height: 630, alt: video.title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}

export default async function VideoRoute({ params }: Props) {
  const video = await getVideo(params.id);
  if (!video) notFound();

  const base = config.appUrl.replace(/\/$/, "");
  const url = `${base}/video/${video.slug || video.id}`;
  const image =
    video.thumbnailUrl ||
    `https://picsum.photos/seed/genhub-video-${video.id}/1200/630`;
  const duration = isoDuration(video.duration);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: video.title,
    description: video.description || undefined,
    thumbnailUrl: [image],
    uploadDate: video.createdAt.toISOString(),
    ...(duration ? { duration } : {}),
    embedUrl: url,
    interactionStatistic: [
      {
        "@type": "InteractionCounter",
        interactionType: "https://schema.org/WatchAction",
        userInteractionCount: video.viewsCount,
      },
      {
        "@type": "InteractionCounter",
        interactionType: "https://schema.org/LikeAction",
        userInteractionCount: video.likesCount,
      },
    ],
    offers: {
      "@type": "Offer",
      price: String(video.price),
      priceCurrency: "TZS",
      availability: "https://schema.org/InStock",
    },
    creator: {
      "@type": "Person",
      name: video.creator.displayName || "Creator",
      url: `${base}/creator/${video.creator.id}`,
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <VideoDetailPage params={params} />
    </>
  );
}
