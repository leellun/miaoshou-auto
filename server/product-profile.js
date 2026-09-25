/** 1688 → 目标平台详情：先锁事实（product_profile），再规划套图（detail_plan）。 */

export const FACT_STATUS = ["confirmed", "inferred", "unknown"];
export const IMAGE_TYPES = ["hero", "sku", "detail", "scene", "size_chart", "package", "infographic", "other"];
export const IMAGE_ROLES = ["product_reference", "factual_evidence", "detail_reference", "visual_inspiration"];
export const PAGE_TYPES = ["hero", "feature", "scene", "detail", "spec", "color", "package"];
export const VARIANT_TYPES = ["color", "size", "sku", "style"];

export function factField(value = null, extra = {}) {
  return {
    value,
    unit: extra.unit ?? null,
    status: extra.status || (value == null || value === "" ? "unknown" : "confirmed"),
    evidence: extra.evidence || [],
  };
}

export function emptyProductProfile() {
  return {
    schema: "product_profile.v1",
    source: {
      platform: "1688",
      url: "",
      item_id: "",
      title: "",
    },
    product: {
      name: "",
      category: "",
      description: "",
      identity: {
        shape: "",
        confirmed_colors: [],
        included_parts: [],
      },
    },
    selling_points: [],
    specs: {
      material: factField(),
      size: factField(null, { unit: null }),
      weight: factField(null, { unit: null }),
      package_size: factField(null, { unit: "cm" }),
      colors: [],
      other: [],
    },
    variants: [],
    images: [],
    claims: {
      confirmed: [],
      excluded: [],
    },
    unknowns: [],
  };
}

export function emptyDetailPlan() {
  return {
    schema: "detail_plan.v1",
    profile_schema: "product_profile.v1",
    market: {
      platform: "tiktok",
      site: "TH",
      language: "th",
    },
    rationale: {
      count_reason: "",
      sequence: "comprehension_to_decision",
    },
    pages: [],
  };
}

export function emptyPlanPage(page = 1) {
  return {
    page,
    type: "hero",
    title: "",
    buyer_question: "",
    reference_images: [],
    reference_roles: {},
    copy: {
      headline: "",
      support: "",
      labels: [],
    },
    invariants: [],
    excluded_claims: [],
    generate: true,
  };
}

export function imageId(index) {
  return `img_${String(index + 1).padStart(2, "0")}`;
}

export function seedProfileImages(files = [], urls = []) {
  return files.map((file, index) => ({
    id: imageId(index),
    type: index === 0 ? "hero" : "other",
    url: urls[index] || "",
    local_path: file,
    description: "",
    facts: [],
    role: "product_reference",
  }));
}

export function exampleProductProfile() {
  const profile = emptyProductProfile();
  profile.source.title = "";
  profile.product.name = "";
  profile.selling_points = [
    {
      id: "sp_01",
      text: "",
      status: "confirmed",
      evidence: ["img_01"],
    },
  ];
  profile.specs.colors = [
    {
      name: "",
      status: "confirmed",
      evidence: ["img_01"],
      sku_scope: "unmapped",
    },
  ];
  profile.specs.other = [
    {
      key: "",
      value: "",
      status: "unknown",
      evidence: [],
    },
  ];
  profile.variants = [
    {
      id: "var_01",
      type: "color",
      label: "",
      evidence: ["img_01"],
      maps_to_all_skus: false,
    },
  ];
  profile.images = [
    {
      id: "img_01",
      type: "hero",
      url: "",
      local_path: "",
      description: "",
      facts: [],
      role: "product_reference",
    },
  ];
  profile.claims.excluded = ["waterproof", "load_rating", "certification", "medical"];
  profile.unknowns = [
    {
      field: "material",
      reason: "图中未见材质标注",
      blocks: ["spec"],
    },
  ];
  return profile;
}

export function exampleDetailPlan() {
  const plan = emptyDetailPlan();
  plan.rationale.count_reason = "按有证据的买家问题定页，不按原图张数翻页";
  plan.pages = [
    {
      page: 1,
      type: "hero",
      title: "核心产品展示",
      buyer_question: "这是什么、长什么样",
      reference_images: ["img_01"],
      reference_roles: { img_01: "product_reference" },
      copy: { headline: "", support: "", labels: [] },
      invariants: ["外形", "颜色", "可见结构"],
      excluded_claims: [],
      generate: true,
    },
    {
      page: 2,
      type: "spec",
      title: "尺寸规格",
      buyer_question: "尺寸是否合适",
      reference_images: ["img_03", "img_04"],
      reference_roles: {
        img_03: "factual_evidence",
        img_04: "detail_reference",
      },
      copy: { headline: "", support: "", labels: [] },
      invariants: ["只写 evidence 中的数字和单位"],
      excluded_claims: ["waterproof", "load_rating"],
      generate: true,
    },
  ];
  return plan;
}

function isStatus(value) {
  return FACT_STATUS.includes(value);
}

export function validateProductProfile(profile) {
  const errors = [];
  if (!profile || profile.schema !== "product_profile.v1") errors.push("schema 必须是 product_profile.v1");
  const ids = new Set();
  for (const image of profile?.images || []) {
    if (!image?.id) errors.push("images[].id 必填");
    else if (ids.has(image.id)) errors.push(`重复图片 id: ${image.id}`);
    else ids.add(image.id);
    if (image.type && !IMAGE_TYPES.includes(image.type)) errors.push(`${image.id} type 不合法`);
    if (image.role && !IMAGE_ROLES.includes(image.role)) errors.push(`${image.id} role 不合法`);
  }
  for (const point of profile?.selling_points || []) {
    if (point.status && !isStatus(point.status)) errors.push(`${point.id || "selling_point"} status 不合法`);
    for (const ref of point.evidence || []) {
      if (ids.size && !ids.has(ref)) errors.push(`${point.id || "selling_point"} 引用了不存在的图 ${ref}`);
    }
  }
  return errors;
}

export function validateDetailPlan(plan, profile) {
  const errors = [];
  if (!plan || plan.schema !== "detail_plan.v1") errors.push("schema 必须是 detail_plan.v1");
  const imageIds = new Set((profile?.images || []).map((image) => image.id).filter(Boolean));
  const pages = plan?.pages || [];
  const seen = new Set();
  for (const page of pages) {
    if (!page?.page) errors.push("pages[].page 必填");
    else if (seen.has(page.page)) errors.push(`重复页码 ${page.page}`);
    else seen.add(page.page);
    if (page.type && !PAGE_TYPES.includes(page.type)) errors.push(`第 ${page.page} 页 type 不合法`);
    const refs = page.reference_images || [];
    if (!refs.length) errors.push(`第 ${page.page} 页至少需要 1 张 reference_images`);
    if (refs.length > 3) errors.push(`第 ${page.page} 页 reference_images 建议不超过 3 张`);
    for (const ref of refs) {
      if (imageIds.size && !imageIds.has(ref)) errors.push(`第 ${page.page} 页引用了不存在的图 ${ref}`);
    }
    const roles = page.reference_roles || {};
    for (const [ref, role] of Object.entries(roles)) {
      if (!refs.includes(ref)) errors.push(`第 ${page.page} 页 reference_roles 含未引用图 ${ref}`);
      if (!IMAGE_ROLES.includes(role)) errors.push(`第 ${page.page} 页 ${ref} role 不合法`);
    }
  }
  return errors;
}
