// =============================================================================
// GENHUB - Video detail page (SEO shell)
// Server component: resolves the video by slug or id for metadata + VideoObject
// structured data, 404s unknown videos, then renders the client player page.
// =============================================================================

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import prisma from "@/lib/db";
import config from "@/lib/config";
import { getCurrentUser } from "@/lib/auth";
import VideoDetailPage from "./VideoDetail";
import { displayHandle } from "@/lib/usernames";
import { serializeJsonLd } from "@/lib/json-ld";
import { getAllVideosFree } from "@/lib/services/platform-setting.service";

interface Props {
  // Next 15 hands route params over as a promise.
  params: Promise<{ id: string }>;
}

/**
 * Resolve a video for this request.
 *
 * A video that is not published is private — but not from its creator. The
 * dashboard menu offers "View as a viewer", and every new upload starts
 * unpublished while Bunny transcodes, so the one link a creator most wants
 * after an upload used to land on "Video not found". `getCurrentUser` reads and
 * verifies the session JWT only (no database round trip), which is what lets
 * this stay a cheap check on a page that is rendered per request anyway.
 */
async function getVideo(id: string, viewer: Awaited<ReturnType<typeof getCurrentUser>>) {
  try {
    const video = await prisma.video.findFirst({
      where: {
        OR: [{ slug: id }, { id }],
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
        isPublished: true,
        createdAt: true,
        creator: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    if (!video) return null;

    const maySeeUnpublished =
      !!viewer && (viewer.role === "ADMIN" || viewer.userId === video.creator.id);

    return video.isPublished || maySeeUnpublished ? video : null;
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
  const { id } = await params;
  const [video, allVideosFree] = await Promise.all([
    getVideo(id, await getCurrentUser()),
    getAllVideosFree(),
  ]);
  if (!video) return { title: "Video not found" };

  const creatorName = displayHandle(video.creator, "Creator");
  // Layout applies the "%s | Genhub" template — don't repeat the brand
  const title = `${video.title} — ${creatorName}`;
  // During a platform-wide free promotion the crawlable title/description must
  // not quote a price either: a search result showing "Unlock for TZS 5,000"
  // while the scene is free is the same wrong number as on the page itself.
  const description =
    (video.description || "").slice(0, 155) ||
    `Watch "${video.title}" by ${creatorName} on Genhub.` +
      (allVideosFree || video.price === 0
        ? " Free to watch."
        : ` Unlock for TZS ${video.price.toLocaleString()}.`);
  const base = config.appUrl.replace(/\/$/, "");
  const url = `${base}/video/${video.slug || video.id}`;
  const image =
    video.thumbnailUrl ||
    `https://picsum.photos/seed/genhub-video-${video.id}/1200/630`;

  return {
    title,
    description,
    // The player fetches its media straight from the Bunny pull zone, and this
    // zone refuses any request that carries a Referer — including our own
    // domain (measured: no Referer 200, `https://www.genhub-two.site/` 403).
    // A browser's default is strict-origin-when-cross-origin, so every segment
    // went out with a Referer and came back 403: the poster, then a spinner,
    // then "refused by the video host". Asking for no referrer on this page
    // makes the browser send the request the CDN actually accepts. The token in
    // the URL still authorises every byte; the referrer check was a second lock
    // that was bolted shut against the only door it was meant to open.
    referrer: "no-referrer",
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
  const { id } = await params;
  const [video, allVideosFree] = await Promise.all([
    getVideo(id, await getCurrentUser()),
    getAllVideosFree(),
  ]);
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
      // Structured data is read by search engines and price comparison tools,
      // so it follows the same rule as the visible page: no price while the
      // platform-wide free switch is on. `0` is a free offer, not a hidden one.
      price: allVideosFree ? "0" : String(video.price),
      priceCurrency: "TZS",
      availability: "https://schema.org/InStock",
    },
    creator: {
      "@type": "Person",
      name: displayHandle(video.creator, "Creator"),
      // Both names when the account has both, so a search for either one lands
      // on the same person.
      ...(video.creator.username && video.creator.displayName
        ? { alternateName: video.creator.displayName }
        : {}),
      url: `${base}/creator/${video.creator.id}`,
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      {/* `params` arrives as a promise now, so the id is unpacked here and the
          client component is handed the plain value it actually needs. */}
      <VideoDetailPage params={{ id }} />
    </>
  );
}
