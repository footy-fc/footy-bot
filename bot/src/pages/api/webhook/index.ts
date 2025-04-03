/* eslint-disable @typescript-eslint/no-explicit-any */
// pages/api/webhook/index.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createHmac } from "crypto";
import { Cast as CastV2 } from "@neynar/nodejs-sdk/build/neynar-api/v2/openapi-farcaster/models/cast.js";
import neynarClient from "@/utils/neynarClient";
import OpenAI from "openai";

// Initialize OpenAI with the API key from your environment variables
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// In-memory store to track processed cast hashes
const processedCasts = new Set<string>();

// Helper function to check if a string contains football-related keywords
function isFootballRelated(text: string): boolean {
  const keywords = ["⚽", "football", "soccer", "footy", "futbol"];
  return keywords.some((keyword) => text.toLowerCase().includes(keyword));
}

/**
 * Use OpenAI to generate a short, conversational welcome message for a new football fan.
 * The response should be concise (no more than 50 words) and include the Footy mini app link.
 * Only tag @gabedev.eth and @kmacb.eth when needed.
 */
async function generateDynamicWelcome(username: string): Promise<string> {
  const prompt = `You are a friendly, conversational football bot. Generate a short, casual welcome message (under 50 words) for a new user named ${username} who loves football. Mention the Footy mini app: https://fc-footy.vercel.app/ and only tag @gabedev.eth and @kmacb.eth if necessary.`;
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
    });
    const message = response.choices[0].message.content;
    return message?.trim() || "";
  } catch (error) {
    console.error("Error generating dynamic welcome message:", error);
    // Fallback to a concise static message if OpenAI fails
    return `Hey ${username}, welcome to Footy! Check out our mini app at https://fc-footy.vercel.app/ for the latest football updates.`;
  }
}

/**
 * Process a cast from a new user to see if they’re football related or mentioning the bot.
 * If so, generate a conversational welcome message using OpenAI.
 */
async function processFootballCaster(
  cast: CastV2,
  botFid: string
): Promise<string | null> {
  // Ensure the cast has an author
  if (!cast.author) {
    console.log("Cast missing author information, hash:", cast.hash);
    return null;
  }
  
  const castHash = cast.hash;
  const fid = cast.author.fid ? cast.author.fid.toString() : null;
  const username = cast.author.username;
  
  // Ensure the author has a valid FID and username
  if (!fid || !username) {
    console.log("Cast missing author fid or username, hash:", cast.hash);
    return null;
  }
  
  // Using display_name per provided type structure
  const displayName = cast.author.display_name?.toLowerCase() || "";
  const castText = cast.text.toLowerCase();

  // Ignore casts from the bot to avoid self-replies
  if (fid === botFid) {
    console.log(`Ignoring cast from bot FID: ${fid}, hash: ${castHash}`);
    return null;
  }

  // Check for duplicate casts
  if (processedCasts.has(castHash)) {
    console.log(`Duplicate cast detected, hash: ${castHash}`);
    return null;
  }
  processedCasts.add(castHash);

  // Determine if the cast is football related:
  // - Check username, displayName, cast text, or if the cast explicitly mentions the bot (e.g., "@footy")
  if (
    !isFootballRelated(username) &&
    !isFootballRelated(displayName) &&
    !isFootballRelated(castText) &&
    !castText.includes("@footy")
  ) {
    console.log(`Cast is not football related, hash: ${castHash}`);
    return null;
  }
  
  // Generate a dynamic, conversational welcome message using OpenAI
  const welcomeMessage = await generateDynamicWelcome(username);
  return welcomeMessage;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    // Ensure the request body is in string format
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const webhookSecret = process.env.NEXT_PUBLIC_NEYNAR_WEBHOOK_SECRET;

    if (
      !process.env.NEXT_PUBLIC_SIGNER_UUID ||
      !process.env.NEXT_PUBLIC_NEYNAR_API_KEY ||
      !webhookSecret
    ) {
      throw new Error(
        "Missing SIGNER_UUID, NEYNAR_API_KEY, or NEYNAR_WEBHOOK_SECRET in .env"
      );
    }

    // Verify the webhook signature from Neynar
    const sig = req.headers["x-neynar-signature"];
    if (!sig || Array.isArray(sig)) {
      throw new Error("Neynar signature missing from request headers");
    }

    const hmac = createHmac("sha512", webhookSecret);
    hmac.update(body);
    const generatedSignature = hmac.digest("hex");

    if (generatedSignature !== sig) {
      throw new Error("Invalid webhook signature");
    }

    // Parse the request body
    const hookData =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // Use bot FID from environment (fallback provided if missing)
    const botFid = process.env.NEXT_PUBLIC_BOT_FID || "935593";

    // Process cast to see if it's from a new football fan or a mention for Footy
    const replyText = await processFootballCaster(hookData.data, botFid);
    if (!replyText) {
      return res.status(200).json({ message: "Ignored cast" });
    }

    // Publish the reply using Neynar client
    const reply = await neynarClient.publishCast(
      process.env.NEXT_PUBLIC_SIGNER_UUID,
      replyText,
      { replyTo: hookData.data.hash }
    );

    return res.status(200).json({ message: reply });
  } catch (error: any) {
    console.error("Webhook error:", error);
    return res.status(500).json({ error: error.message });
  }
}
