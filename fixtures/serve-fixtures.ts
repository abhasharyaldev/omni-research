/** CLI: serve the fixture website on http://127.0.0.1:4799 (for e2e/demo). */
import { startFixtureServer } from "./serve-lib.js";

const port = Number(process.env.FIXTURE_PORT || 4799);
startFixtureServer(port).then((server) => {
  console.log(`Fixture website serving at http://127.0.0.1:${server.port}`);
  console.log("Pages: /articles/spaced-repetition.html, /articles/learning-science.html,");
  console.log("       /articles/injection-attempt.html, /feed.xml, /sitemap.xml, /private/secret.html (robots-blocked)");
});
