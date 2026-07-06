import { describe, expect, it } from "vitest";
import { percentEncode, signOAuthRequest } from "@/lib/is24/oauth";

describe("percentEncode (RFC 3986)", () => {
  it("encodiert Sonderzeichen, die encodeURIComponent auslässt", () => {
    expect(percentEncode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(percentEncode("Ladies + Gentlemen")).toBe("Ladies%20%2B%20Gentlemen");
    expect(percentEncode("safe-chars_~.")).toBe("safe-chars_~.");
  });
});

describe("signOAuthRequest (HMAC-SHA1)", () => {
  // Offizieller Referenz-Testvektor aus der Twitter-OAuth-1.0a-Dokumentation.
  it("reproduziert den bekannten Referenz-Signaturwert", async () => {
    const result = await signOAuthRequest({
      method: "POST",
      url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      credentials: {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      extraParams: {
        status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      },
      timestamp: "1318622958",
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    });

    // Erwartete Werte unabhängig mit node:crypto gegen den in der Doku
    // abgedruckten Signature-Base-String verifiziert.
    expect(result.signatureBase).toBe(
      "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
    expect(result.signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
    expect(result.authorizationHeader).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(result.authorizationHeader).toContain('oauth_version="1.0"');
    expect(result.authorizationHeader.startsWith("OAuth ")).toBe(true);
  });

  it("bezieht Query-Parameter der URL in die Signatur ein", async () => {
    const credentials = {
      consumerKey: "key",
      consumerSecret: "secret",
      accessToken: "token",
      accessTokenSecret: "tokensecret",
    };
    const common = { method: "GET", credentials, timestamp: "1700000000", nonce: "fixednonce" };
    const a = await signOAuthRequest({ ...common, url: "https://api.example.de/x?pagenumber=1" });
    const b = await signOAuthRequest({ ...common, url: "https://api.example.de/x?pagenumber=2" });
    expect(a.signature).not.toBe(b.signature);
  });

  it("erzeugt ohne injizierte Werte Nonce und Timestamp selbst", async () => {
    const result = await signOAuthRequest({
      method: "GET",
      url: "https://rest.immobilienscout24.de/restapi/api/offer/v1.0/user/me/realestate",
      credentials: {
        consumerKey: "k",
        consumerSecret: "s",
        accessToken: "t",
        accessTokenSecret: "ts",
      },
    });
    expect(result.authorizationHeader).toMatch(/oauth_nonce="[0-9a-f]{32}"/);
    expect(result.authorizationHeader).toMatch(/oauth_timestamp="\d{10}"/);
  });
});
