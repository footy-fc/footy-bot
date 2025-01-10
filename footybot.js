const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(express.json());

// Environment Variables
const PORT = process.env.PORT || 3000;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const NEYNAR_SIGNER_UUID = process.env.NEYNAR_SIGNER_UUID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Fetch ESPN Data
async function fetchESPNData(team1, team2) {
  try {
    const url = "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard";
    const response = await axios.get(url);
    const events = response.data.events;

    // Find the specific match based on team names
    const match = events.find((event) => {
      const competitors = event.competitions[0]?.competitors;
      if (!competitors) return false;

      const homeTeam = competitors.find((c) => c.homeAway === "home");
      const awayTeam = competitors.find((c) => c.homeAway === "away");

      return (
        homeTeam?.team.displayName.toLowerCase().includes(team1.toLowerCase()) &&
        awayTeam?.team.displayName.toLowerCase().includes(team2.toLowerCase())
      );
    });

    if (!match) {
      return `Oops! Couldn't find data for ${team1} vs ${team2}. Try another query! ⚽`;
    }

    return match;
  } catch (error) {
    console.error("Error fetching ESPN data:", error.message);
    return "Oh no! Couldn't fetch data right now. Try again later. 🚨";
  }
}

// Process Match Data
async function processMatchData(match, aiIntent) {
  try {
    const { competitions, venue, status } = match;
    const competitors = competitions[0]?.competitors;

    if (!competitors) return "Sorry, I couldn't find team details for this match. 🧐";

    const homeTeam = competitors.find((c) => c.homeAway === "home");
    const awayTeam = competitors.find((c) => c.homeAway === "away");

    switch (aiIntent) {
      case "scores":
        return `📊 Scores:\n⚪ ${homeTeam.team.displayName}: ${homeTeam.score}\n🔵 ${awayTeam.team.displayName}: ${awayTeam.score}\nStatus: ${status.type.description}.`;

      case "venue":
        return venue
          ? `📍 The match is happening at **${venue.displayName}**. 🏟️`
          : "Hmm, couldn't find the venue. 😕";

      case "team_stats":
        return `📈 Team Stats:\n⚪ ${homeTeam.team.displayName}: ${homeTeam.records[0]?.summary || "No stats available"}\n🔵 ${awayTeam.team.displayName}: ${awayTeam.records[0]?.summary || "No stats available"}.`;

      case "odds":
        const odds = competitions[0]?.odds?.[0];
        return odds
          ? `💰 Betting Odds:\n⚪ ${homeTeam.team.displayName}: ${odds.homeTeamOdds?.summary || "N/A"}\n🔵 ${awayTeam.team.displayName}: ${odds.awayTeamOdds?.summary || "N/A"}\n🤝 Draw: ${odds.drawOdds?.summary || "N/A"}`
          : "No odds data available. 🙃";

      default:
        return "Hmm, I'm not sure how to answer that. Try asking about scores, venue, stats, or odds! 🤔";
    }
  } catch (error) {
    console.error("Error processing match data:", error.message);
    return "Error processing match data. Please try again later. 🚨";
  }
}

// Parse AI Response
function parseAIResponse(aiResponse) {
  const intentMatch = aiResponse.match(/User Intent: (.*)/i);
  const intent = intentMatch ? intentMatch[1].toLowerCase() : "unknown";

  const teamsMatch = aiResponse.match(/Teams: (.*), (.*)/i);
  const teams = teamsMatch ? [teamsMatch[1].trim(), teamsMatch[2].trim()] : null;

  return { intent, teams };
}

// Process Query with OpenAI
async function processQueryWithOpenAI(text) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are a football bot. Analyze the query and extract:
          1. User Intent (e.g., "scores", "venue", "team_stats", "odds").
          2. Team Names involved.
          Respond like:
          "User Intent: [intent]\nTeams: [team1], [team2]".`,
        },
        { role: "user", content: text },
      ],
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error processing query with OpenAI:", error.message);
    return "Couldn't process your query. Please try again later! 🚨";
  }
}

// Respond to Cast
async function respondToCast(castHash, responseText) {
  try {
    const url = "https://api.neynar.com/v2/farcaster/cast";
    const response = await axios.post(
      url,
      {
        text: responseText,
        parent: castHash,
        signer_uuid: NEYNAR_SIGNER_UUID,
      },
      {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": NEYNAR_API_KEY,
        },
      }
    );
    console.log("Response sent:", response.data);
  } catch (error) {
    console.error("Error responding to cast:", error.message);
  }
}

// Webhook Handler
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.type !== "cast.created") {
      return res.sendStatus(200);
    }

    const cast = event.data;
    const { text, hash } = cast;

    const aiResponse = await processQueryWithOpenAI(text);
    const { intent, teams } = parseAIResponse(aiResponse);

    if (!teams || intent === "unknown") {
      await respondToCast(hash, "Sorry, I couldn't understand your query. ⚽ Try asking about scores, venue, stats, or odds!");
      return res.sendStatus(200);
    }

    const [team1, team2] = teams;
    const match = await fetchESPNData(team1, team2);

    if (typeof match === "string") {
      await respondToCast(hash, match);
      return res.sendStatus(200);
    }

    const responseText = await processMatchData(match, intent);
    await respondToCast(hash, responseText);

    res.sendStatus(200);
  } catch (error) {
    console.error("Error handling webhook:", error.message);
    res.sendStatus(500);
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Listening for webhooks on http://localhost:${PORT}`);
});
