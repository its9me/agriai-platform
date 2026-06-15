import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function dateText(value: unknown) {
  if (!value) return "غير متوفر";
  return new Date(String(value)).toLocaleString("ar-IQ");
}

function riskText(summary: unknown) {
  const risk = (summary as { risk_level?: string } | null)?.risk_level;
  return risk ?? "unknown";
}

function plantsText(summary: unknown) {
  const plants = summary as Array<{ name?: string; count?: number }> | null;
  if (!Array.isArray(plants) || !plants.length) return "لا توجد نباتات مؤكدة";
  return plants
    .slice(0, 4)
    .map((plant) => `${plant.name ?? "نبات"}: ${plant.count ?? "?"}`)
    .join("، ");
}

function evidenceList(items: unknown) {
  if (!Array.isArray(items) || !items.length) return "لا توجد أدلة مسجلة";
  return items.slice(0, 4).map((item) => String(item)).join("، ");
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);

  if (!Number.isFinite(landId)) {
    return new NextResponse("Invalid land id", { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [
      landResult,
      imageryResult,
      analysesResult,
      recommendationsResult,
      commandsResult,
      devicesResult,
      telemetryResult,
      notesResult,
      plansResult,
      decisionsResult
    ] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,centroid,created_at")
        .eq("id", landId)
        .single(),
      supabase
        .from("imagery")
        .select("id,image_url,source,captured_at,metadata,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("ai_analyses")
        .select("id,plant_summary,pest_summary,confidence,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("irrigation_recommendations")
        .select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("iot_commands")
        .select("id,status,payload,published_at,acknowledged_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("iot_devices")
        .select("id,device_uid,is_active,last_seen_at")
        .eq("land_id", landId),
      supabase
        .from("iot_telemetry")
        .select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,valve_state,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("field_notes")
        .select("id,note,triage_json,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("ai_action_plans")
        .select("id,plan_json,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("ai_decisions")
        .select("id,decision_json,evidence_counts,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5)
    ]);

    if (landResult.error) throw landResult.error;

    const land = landResult.data;
    const imagery = imageryResult.error ? [] : (imageryResult.data ?? []);
    const analyses = analysesResult.error ? [] : (analysesResult.data ?? []);
    const recommendations = recommendationsResult.error ? [] : (recommendationsResult.data ?? []);
    const commands = commandsResult.error ? [] : (commandsResult.data ?? []);
    const devices = devicesResult.error ? [] : (devicesResult.data ?? []);
    const telemetry = telemetryResult.error ? [] : (telemetryResult.data ?? []);
    const notes = notesResult.error ? [] : (notesResult.data ?? []);
    const plans = plansResult.error ? [] : (plansResult.data ?? []);
    const decisions = decisionsResult.error ? [] : (decisionsResult.data ?? []);

    const latestAnalysis = analyses[0];
    const latestPestSummary = latestAnalysis?.pest_summary as {
      detected?: boolean;
      risk_level?: string;
      suspected_pests?: Array<{ name?: string; evidence?: string[]; confidence?: number }>;
      red_palm_weevil_indicators?: {
        detected?: boolean;
        evidence?: string[];
        confidence?: number;
      };
    } | undefined;
    const redPalmWatch = latestPestSummary?.red_palm_weevil_indicators;
    const suspectedPests = latestPestSummary?.suspected_pests ?? [];
    const latestRecommendation = recommendations[0];
    const latestDecision = decisions[0]?.decision_json as {
      headline?: string;
      decision?: string;
      risk_level?: string;
      confidence?: number;
      why?: string;
      farmer_next_actions?: Array<{
        title?: string;
        priority?: string;
        time_window?: string;
        success_check?: string;
      }>;
      automation?: {
        allowed?: boolean;
        reason?: string;
        suggested_duration_seconds?: number;
      };
    } | undefined;
    const latestPlan = plans[0]?.plan_json as {
      plan_title?: string;
      decision?: string;
      decision_reason?: string;
      tasks?: Array<{
        day?: number;
        title?: string;
        owner?: string;
        priority?: string;
        evidence?: string;
        success_metric?: string;
      }>;
    } | undefined;
    const latestTelemetry = telemetry[0];
    const activeDevices = devices.filter((device) => device.is_active).length;
    const generatedAt = new Date();
    const centroid = land.centroid as { coordinates?: [number, number] } | null;
    const lon = centroid?.coordinates?.[0];
    const lat = centroid?.coordinates?.[1];
    const weather = Number.isFinite(lat) && Number.isFinite(lon)
      ? await getWeather(Number(lat), Number(lon)).catch(() => null)
      : null;
    const maxTemp = weather?.forecast?.reduce((max, item) => Math.max(max, Number(item.tempC ?? 0)), 0) ?? null;
    const reportTasks = latestDecision?.farmer_next_actions?.length
      ? latestDecision.farmer_next_actions.map((task, index) => ({
        step: index + 1,
        title: task.title ?? "مهمة تشغيلية",
        owner: "operator",
        priority: task.priority ?? "medium",
        evidence: latestDecision.headline ?? latestDecision.why ?? "قرار AI موحد",
        doneWhen: task.success_check ?? "تم توثيق التنفيذ في سجل الأرض",
        timeWindow: task.time_window ?? "خلال 24 ساعة"
      }))
      : latestPlan?.tasks?.length
        ? latestPlan.tasks.slice(0, 5).map((task, index) => ({
          step: index + 1,
          title: task.title ?? "مهمة تشغيلية",
          owner: task.owner ?? "operator",
          priority: task.priority ?? "medium",
          evidence: task.evidence ?? latestPlan.decision_reason ?? "خطة تنفيذ AI",
          doneWhen: task.success_metric ?? "تم إنجاز المهمة",
          timeWindow: task.day ? `اليوم ${task.day}` : "خلال الخطة"
        }))
        : [
          {
            step: 1,
            title: latestRecommendation ? "مراجعة توصية الري قبل التنفيذ" : "توليد توصية ري من صورة أو مستشار AI",
            owner: "operator",
            priority: latestRecommendation ? "medium" : "high",
            evidence: latestRecommendation
              ? `${Number(latestRecommendation.total_liters_per_day ?? 0).toFixed(1)} لتر/يوم`
              : "لا توجد توصية ري محفوظة",
            doneWhen: "تم تسجيل القرار أو إرسال الأمر للجهاز",
            timeWindow: "اليوم"
          }
        ];

    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>تقرير الأرض - ${escapeHtml(land.name)}</title>
  <style>
    :root { color-scheme: light; --ink:#17221c; --muted:#66756b; --line:#d9e2d7; --accent:#177245; --paper:#fbfcfb; }
    * { box-sizing: border-box; }
    body { margin:0; background:#edf3ef; color:var(--ink); font-family: Arial, Tahoma, sans-serif; line-height:1.6; }
    main { width:min(1040px, calc(100% - 28px)); margin:24px auto; background:white; border:1px solid var(--line); border-radius:8px; padding:24px; }
    header { display:flex; justify-content:space-between; gap:18px; align-items:flex-start; border-bottom:3px solid var(--accent); padding-bottom:18px; }
    h1, h2, h3, p { margin-top:0; }
    h1 { font-size:30px; margin-bottom:8px; }
    h2 { font-size:19px; margin-bottom:10px; }
    .muted { color:var(--muted); }
    .badge { border:1px solid var(--line); border-radius:999px; padding:8px 12px; background:var(--paper); font-weight:700; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; margin:18px 0; }
    .card { border:1px solid var(--line); border-radius:8px; padding:13px; background:var(--paper); }
    .card span { display:block; color:var(--muted); font-size:13px; margin-bottom:6px; }
    .card strong { font-size:20px; overflow-wrap:anywhere; }
    section { margin-top:22px; }
    .cols { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:12px; }
    .item { border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:9px; background:white; }
    .item strong { display:block; margin-bottom:4px; }
    .decision { border:1px solid rgba(23,114,69,.32); background:#f1faf4; border-radius:8px; padding:16px; }
    .warning { border:1px solid rgba(138,109,47,.35); background:#fffaf0; border-radius:8px; padding:13px; }
    table { width:100%; border-collapse:collapse; }
    th, td { border-bottom:1px solid var(--line); padding:9px; text-align:right; vertical-align:top; }
    th { color:var(--muted); font-size:13px; }
    footer { margin-top:24px; color:var(--muted); font-size:13px; border-top:1px solid var(--line); padding-top:12px; }
    @media print { body { background:white; } main { width:100%; margin:0; border:0; } .noPrint { display:none; } }
    @media (max-width: 760px) { header, .grid, .cols { grid-template-columns:1fr; display:grid; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapeHtml(land.name)}</h1>
        <p class="muted">تقرير أرض قابل للطباعة للعرض أمام الحكام، مبني على سجلات Supabase الفعلية.</p>
        <p class="muted">المحصول: ${escapeHtml(land.crop_hint ?? "غير محدد")} / المساحة: ${Number(land.area_m2 ?? 0).toLocaleString("ar-IQ")} م2</p>
      </div>
      <div class="badge">تولد في ${escapeHtml(generatedAt.toLocaleString("ar-IQ"))}</div>
    </header>

    <div class="grid">
      <div class="card"><span>صور محفوظة</span><strong>${imagery.length}</strong></div>
      <div class="card"><span>تحليلات AI</span><strong>${analyses.length}</strong></div>
      <div class="card"><span>توصيات ري</span><strong>${recommendations.length}</strong></div>
      <div class="card"><span>أجهزة فعالة</span><strong>${activeDevices}/${devices.length}</strong></div>
      <div class="card"><span>قراءات حساسات</span><strong>${telemetry.length}</strong></div>
      <div class="card"><span>أوامر IoT</span><strong>${commands.length}</strong></div>
      <div class="card"><span>ملاحظات ميدانية</span><strong>${notes.length}</strong></div>
      <div class="card"><span>قرارات AI محفوظة</span><strong>${decisions.length}</strong></div>
    </div>

    <section class="decision">
      <h2>القرار الحالي</h2>
      <h3>${escapeHtml(latestDecision?.headline ?? latestPlan?.plan_title ?? "لا يوجد قرار AI محفوظ بعد")}</h3>
      <p>${escapeHtml(latestDecision?.why ?? latestPlan?.decision_reason ?? "شغّل زر قرار AI موحد أو خطة تنفيذ AI لإنتاج قرار قابل للتدقيق.")}</p>
      <div class="grid">
        <div class="card"><span>نوع القرار</span><strong>${escapeHtml(latestDecision?.decision ?? latestPlan?.decision ?? "غير متوفر")}</strong></div>
        <div class="card"><span>مستوى الخطر</span><strong>${escapeHtml(latestDecision?.risk_level ?? riskText(latestAnalysis?.pest_summary))}</strong></div>
        <div class="card"><span>ثقة AI</span><strong>${Number(latestDecision?.confidence ?? latestAnalysis?.confidence ?? 0).toFixed(2)}</strong></div>
        <div class="card"><span>آخر تحديث</span><strong>${escapeHtml(dateText(decisions[0]?.created_at ?? plans[0]?.created_at ?? latestAnalysis?.created_at))}</strong></div>
      </div>
    </section>

    <section>
      <h2>آخر تحليل صورة</h2>
      <div class="cols">
        <div class="item">
          <strong>النباتات المرصودة</strong>
          <span>${escapeHtml(plantsText(latestAnalysis?.plant_summary))}</span>
        </div>
        <div class="item">
          <strong>مخاطر الآفات</strong>
          <span>${escapeHtml(riskText(latestAnalysis?.pest_summary))} / ثقة ${Number(latestAnalysis?.confidence ?? 0).toFixed(2)}</span>
        </div>
      </div>
    </section>

    <section class="warning">
      <h2>استجابة الآفات وسوسة النخيل</h2>
      <div class="cols">
        <div class="item">
          <strong>مراقبة سوسة النخيل الحمراء</strong>
          <span>${redPalmWatch?.detected ? "مؤشرات مشتبه بها" : "لا توجد مؤشرات مؤكدة"} / ثقة ${Number(redPalmWatch?.confidence ?? 0).toFixed(2)}</span>
        </div>
        <div class="item">
          <strong>أدلة سوسة النخيل</strong>
          <span>${escapeHtml(evidenceList(redPalmWatch?.evidence))}</span>
        </div>
        <div class="item">
          <strong>آفات مشتبه بها</strong>
          <span>${suspectedPests.length ? suspectedPests.slice(0, 3).map((pest) => `${pest.name ?? "آفة"} (${Number(pest.confidence ?? 0).toFixed(2)})`).join("، ") : "لا توجد آفات مشتبه بها"}</span>
        </div>
        <div class="item">
          <strong>إجراء فوري</strong>
          <span>${redPalmWatch?.detected || riskText(latestAnalysis?.pest_summary) === "high" ? "افحص الجذع والتاج وصور أي ثقوب أو إفرازات قبل الري التلقائي." : "استمر بالمراقبة والتقط صوراً قريبة للجذع والتاج لتحسين الدليل."}</span>
        </div>
      </div>
    </section>

    <section>
      <h2>الري والحساسات</h2>
      <div class="cols">
        <div class="item">
          <strong>آخر توصية ري</strong>
          <span>${latestRecommendation ? `${Number(latestRecommendation.total_liters_per_day ?? 0).toFixed(1)} لتر/يوم، مدة ${latestRecommendation.recommended_duration_seconds ?? 0} ثانية، الحالة ${escapeHtml(latestRecommendation.status)}` : "لا توجد توصية ري محفوظة"}</span>
        </div>
        <div class="item">
          <strong>آخر قراءة ESP32</strong>
          <span>${latestTelemetry ? `رطوبة ${latestTelemetry.soil_moisture_percent ?? "?"}%، حرارة ${latestTelemetry.temperature_c ?? "?"}°C، صمام ${escapeHtml(latestTelemetry.valve_state ?? "unknown")}` : "لا توجد قراءة حساسات محفوظة"}</span>
        </div>
      </div>
    </section>

    <section>
      <h2>تنبيه طقس وري مختصر</h2>
      <div class="cols">
        <div class="item">
          <strong>المطر المتوقع</strong>
          <span>${weather ? `${Number(weather.forecastRainMm ?? 0).toFixed(1)} mm خلال التوقعات القادمة` : "غير متوفر من OpenWeather حالياً"}</span>
        </div>
        <div class="item">
          <strong>الحرارة الأعلى</strong>
          <span>${maxTemp === null ? "غير متوفرة" : `${maxTemp.toFixed(1)}°C`}</span>
        </div>
        <div class="item">
          <strong>تأثير المطر على الري</strong>
          <span>${latestRecommendation ? `تم خصم ${Number(latestRecommendation.rain_deduction_liters ?? 0).toFixed(1)} لتر من توصية الري بسبب المطر.` : "لا توجد توصية ري تقيس أثر المطر بعد."}</span>
        </div>
        <div class="item">
          <strong>الأتمتة</strong>
          <span>${latestDecision?.automation ? `${latestDecision.automation.allowed ? "ممكنة بعد الموافقة" : "تحتاج مراجعة"} / ${escapeHtml(latestDecision.automation.reason ?? "")}` : "شغّل قرار AI موحد لتقييم الأتمتة."}</span>
        </div>
      </div>
    </section>

    <section>
      <h2>قائمة مهام المشغل</h2>
      <table>
        <thead><tr><th>#</th><th>المهمة</th><th>المسؤول</th><th>الدليل</th><th>تنجز عند</th></tr></thead>
        <tbody>
          ${reportTasks.map((task) => `<tr><td>${task.step}</td><td>${escapeHtml(task.title)}<br/><span class="muted">${escapeHtml(task.priority)} / ${escapeHtml(task.timeWindow)}</span></td><td>${escapeHtml(task.owner)}</td><td>${escapeHtml(task.evidence)}</td><td>${escapeHtml(task.doneWhen)}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>

    <section>
      <h2>سجل أدلة مختصر</h2>
      <table>
        <thead><tr><th>النوع</th><th>النتيجة</th><th>الوقت</th></tr></thead>
        <tbody>
          ${analyses.slice(0, 4).map((analysis) => `<tr><td>تحليل AI</td><td>خطر ${escapeHtml(riskText(analysis.pest_summary))} / ثقة ${Number(analysis.confidence ?? 0).toFixed(2)}</td><td>${escapeHtml(dateText(analysis.created_at))}</td></tr>`).join("")}
          ${recommendations.slice(0, 4).map((rec) => `<tr><td>توصية ري</td><td>${Number(rec.total_liters_per_day ?? 0).toFixed(1)} لتر / ${rec.recommended_duration_seconds ?? 0} ثانية / ${escapeHtml(rec.status)}</td><td>${escapeHtml(dateText(rec.created_at))}</td></tr>`).join("")}
          ${commands.slice(0, 3).map((command) => `<tr><td>أمر IoT</td><td>${escapeHtml(command.status)}</td><td>${escapeHtml(dateText(command.created_at))}</td></tr>`).join("")}
          ${notes.slice(0, 3).map((note) => `<tr><td>ملاحظة ميدانية</td><td>${escapeHtml(note.note)}</td><td>${escapeHtml(dateText(note.created_at))}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>

    ${decisionsResult.error ? `<section class="warning"><strong>تنبيه أرشفة القرارات:</strong> جدول ai_decisions غير مفعّل بعد. شغّل outputs/ai_decisions_schema.sql ليظهر سجل القرارات هنا.</section>` : ""}

    <footer>
      هذا التقرير لا يخترع بيانات. أي نقص ظاهر هنا يعني أن المنصة تحتاج صورة، قراءة حساس، توصية ري، أو قرار AI محفوظ قبل العرض النهائي.
    </footer>
  </main>
</body>
</html>`;

    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8"
      }
    });
  } catch (error) {
    return new NextResponse(
      `<html lang="ar" dir="rtl"><body><h1>فشل توليد التقرير</h1><p>${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</p></body></html>`,
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      }
    );
  }
}
