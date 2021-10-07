const { description } = require("../../package");

module.exports = (ctx) => {
  const head = [
    ["meta", { name: "theme-color", content: "#3eaf7c" }],
    ["meta", { name: "apple-mobile-web-app-capable", content: "yes" }],
    ["link", { rel: "icon", href: "/favicon.png" }],
    [
      "meta",
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
    [
      "meta",
      { name: "apple-mobile-web-app-status-bar-style", content: "black" },
    ],
  ];
  if (process.env.NODE_ENV === "production") {
    head.push([
      "script",
      {
        async: "",
        src:
          "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-0248074489415800",
        crossorigin: "anonymous",
      },
    ]);
  }
  return {
    /**
     * Ref：https://v1.vuepress.vuejs.org/config/#title
     */
    title: "Codelibs Recotem",
    /**
     * Ref：https://v1.vuepress.vuejs.org/config/#description
     */
    description: description,
    /**
     * Extra tags to be injected to the page HTML `<head>`
     *
     * ref：https://v1.vuepress.vuejs.org/config/#head
     */
    head,
    locales: {
      "/": {
        lang: "en-US", // this will be set as the lang attribute on <html>
        title: "Recotem",
        description: "An easy interface to recommendation system",
      },
      "/ja/": {
        lang: "ja-JA",
        title: "Recotem",
        description: "専門知識の要らないレコメンドサーバー",
      },
    },
    /**
     * Theme configuration, here is the default theme configuration for VuePress.
     *
     * ref：https://v1.vuepress.vuejs.org/theme/default-theme-config.html
     */
    themeConfig: {
      logo: "/recotem-header.png",
      repo: "codelibs/recotem",
      editLinks: false,
      docsDir: "",
      lastUpdated: false,
      locales: {
        "/": {
          selectText: "Languages",
          label: "English",
          ariaLabel: "Select Languages",
          sidebar: {
            "/guide/": getGuideSidebar("Basics", "Advanced"),
            "/docs/": [],
          },
          nav: [
            {
              text: "Guide",
              link: "/guide/",
            },
            {
              text: "Docs",
              link: "/docs/",
            },
          ],
        },
        "/ja/": {
          selectText: "言語",
          label: "日本語",
          ariaLabel: "Languages",
          sidebar: {
            "/ja/guide/": getGuideSidebar("基礎編", "進んだ使い方"),
            "/ja/docs/": getDocsSidebar("Dockerコンテナ", "ユーザーページ"),
          },
          nav: [
            {
              text: "ガイド",
              link: "/ja/guide/",
            },
            {
              text: "ドキュメント",
              link: "/ja/docs/",
            },
          ],
        },
      },
    },

    /**
     * Apply plugins，ref：https://v1.vuepress.vuejs.org/zh/plugin/
     */
    plugins: {
      "@vuepress/plugin-back-to-top": {},
      "@vuepress/plugin-medium-zoom": {},
      "vuepress-plugin-export": {},
      "vuepress-plugin-google-tag-manager": {
        gtm: process.env.NODE_ENV === "production" ? "GTM-5QR8QHV" : undefined,
      },
      sitemap: {
        hostname: "https://recotem.org",
      },
    },
  };
};

function getGuideSidebar(basicTitle, advancedTitle) {
  return [
    {
      title: basicTitle,
      collapsable: true,
      children: ["", "installation.md", "tutorial/"],
    },
    {
      title: advancedTitle,
      collapsable: true,
      children: ["cli.md", "batch.md"],
    },
  ];
}
function getDocsSidebar(basicTitle, advancedTitle) {
  return [
    {
      title: basicTitle,
      collapsable: false,
      children: ["", "./build"],
    },
    {
      title: advancedTitle,
      collapsable: true,
      children: [
        "user/project-list/",
        "user/project/",
        "user/data-list/",
        "user/data-detail/",
        "user/start-tuning/",
        "user/start-tuning-with-data/",
        "user/first-tuning/",
        "user/tuning-job-list/",
        "user/tuning-job-detail/",
        "user/trained-model-detail/",
        "user/trained-model-list/",
        "user/start-training/",
      ],
    },
  ];
}
