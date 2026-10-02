// =============================================================================
// GENHUB - Admin platform settings
// GET  /api/admin/settings  - read the operator switches
// POST /api/admin/settings  - change one or more
//
//   allVideosFree     every paid scene plays for everyone
//   uploadsEnabled    kill switch for creator uploads
//   checkoutEnabled   kill switch for mobile-money checkout
//   announcement      the site-wide banner ({ active, message, tone })
//
// Its own route rather than a field on /api/admin/overview: the overview is
// cached for two minutes, and an operator switch that takes two minutes to be
// believed is a switch nobody trusts. Reading here is uncached.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import {
  PLATFORM_SETTING_KEYS,
  getAllVideosFree,
  getAnnouncement,
  getFeatureFlags,
  normalizeAnnouncementTone,
  setSetting,
  type Announcement,
} from "@/lib/services/platform-setting.service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");
    const [allVideosFree, flags, announcement] = await Promise.all([
      getAllVideosFree(),
      getFeatureFlags(),
      getAnnouncement(),
    ]);
    return api.success({ allVideosFree, flags, announcement });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Settings GET Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await readJsonBody(request);
    if (!body || typeof body !== "object") return api.validation("Nothing to change");

    const changed: string[] = [];

    if (typeof body.allVideosFree === "boolean") {
      await setSetting(
        PLATFORM_SETTING_KEYS.allVideosFree,
        body.allVideosFree ? "true" : "false",
        auth.userId
      );
      changed.push(body.allVideosFree ? "all videos free" : "videos paid again");
      await recordAudit({
        actorId: auth.userId,
        action: body.allVideosFree ? AUDIT_ACTIONS.videosAllFree : AUDIT_ACTIONS.videosPaid,
        targetType: "PlatformSetting",
        targetId: PLATFORM_SETTING_KEYS.allVideosFree,
        summary: body.allVideosFree
          ? "Turned ON free viewing for every video on the platform"
          : "Turned OFF free viewing — every video is paid again",
        detail: { allVideosFree: true },
      });
    }

    if (typeof body.uploadsEnabled === "boolean") {
      await setSetting(
        PLATFORM_SETTING_KEYS.uploadsEnabled,
        body.uploadsEnabled ? "true" : "false",
        auth.userId
      );
      changed.push(body.uploadsEnabled ? "uploads resumed" : "uploads paused");
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.featureToggle,
        targetType: "PlatformSetting",
        targetId: PLATFORM_SETTING_KEYS.uploadsEnabled,
        summary: `${body.uploadsEnabled ? "Resumed" : "Paused"} creator uploads`,
        detail: { uploadsEnabled: body.uploadsEnabled },
      });
    }

    if (typeof body.checkoutEnabled === "boolean") {
      await setSetting(
        PLATFORM_SETTING_KEYS.checkoutEnabled,
        body.checkoutEnabled ? "true" : "false",
        auth.userId
      );
      changed.push(body.checkoutEnabled ? "checkout resumed" : "checkout paused");
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.featureToggle,
        targetType: "PlatformSetting",
        targetId: PLATFORM_SETTING_KEYS.checkoutEnabled,
        summary: `${body.checkoutEnabled ? "Resumed" : "Paused"} mobile-money checkout`,
        detail: { checkoutEnabled: body.checkoutEnabled },
      });
    }

    if (body.announcement && typeof body.announcement === "object") {
      const raw = body.announcement as Partial<Announcement>;
      const announcement: Announcement = {
        active: raw.active === true,
        message: typeof raw.message === "string" ? raw.message.slice(0, 500) : "",
        // Red by default (see normalizeAnnouncementTone): an announcement is
        // published to be noticed.
        tone: normalizeAnnouncementTone(raw.tone),
      };
      await setSetting(
        PLATFORM_SETTING_KEYS.announcement,
        JSON.stringify(announcement),
        auth.userId
      );
      changed.push(announcement.active ? "announcement published" : "announcement cleared");
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.featureToggle,
        targetType: "PlatformSetting",
        targetId: PLATFORM_SETTING_KEYS.announcement,
        summary: announcement.active
          ? `Published a site announcement: ${announcement.message.slice(0, 120)}`
          : "Cleared the site announcement",
        detail: {
          active: announcement.active,
          message: announcement.message,
          tone: announcement.tone,
        },
      });
    }

    if (changed.length === 0) return api.validation("Nothing to change");

    const [allVideosFree, flags, announcement] = await Promise.all([
      getAllVideosFree(),
      getFeatureFlags(),
      getAnnouncement(),
    ]);

    return api.success(
      { allVideosFree, flags, announcement },
      `Saved: ${changed.join(", ")}`
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Settings POST Error]", error);
    return api.internal();
  }
}
