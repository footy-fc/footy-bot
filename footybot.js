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

    console.log("ESPN API Response:", events); // Debugging log

    // Find the specific match based on team names
    const match = events.find((event) => {
      const competitors = event.competitions[0].competitors;
      const homeTeam = competitors.find((c) => c.homeAway === "home");
      const awayTeam = competitors.find((c) => c.homeAway === "away");

      return (
        homeTeam.team.displayName.toLowerCase().includes(team1.toLowerCase()) &&
        awayTeam.team.displayName.toLowerCase().includes(team2.toLowerCase())
      );
    });

    if (!match) {
      return `Sorry, I couldn't find match data for ${team1} vs ${team2}.`;
    }

    return match; // Return the full match object for dynamic handling
  } catch (error) {
    console.error("Error fetching ESPN data:", error.message);
    return "Error fetching data from ESPN API. Please try again later.";
  }
}

// Process Match Data Based on AI Intent
// Process Match Data Based on AI Intent
async function processMatchData(match, aiIntent) {
    try {
      // Validate structure of the match object
      if (!match || !match.competitions || !match.competitions[0]) {
        return "Sorry, the match data is incomplete or unavailable.";
      }
  
      const { competitions, venue, status } = match;
      const competitors = competitions[0].competitors;
  
      if (!competitors) {
        return "Sorry, competitor data is missing for this match.";
      }
  
      const homeTeam = competitors.find((c) => c.homeAway === "home");
      const awayTeam = competitors.find((c) => c.homeAway === "away");
  
      if (!homeTeam || !awayTeam) {
        return "Sorry, team data is incomplete for this match.";
      }
  
      // Handle the intent dynamically
      switch (aiIntent) {
        case "scores":
          return `Scores:\n${homeTeam.team.displayName}: ${homeTeam.score}\n${awayTeam.team.displayName}: ${awayTeam.score}\nStatus: ${status.type.description}`;
        case "venue":
          if (!venue) return "Sorry, venue data is unavailable.";
          return `The match is taking place at ${venue.displayName}.`;
        case "team_stats":
          return `Team Stats:\n${homeTeam.team.displayName}: ${homeTeam.records[0]?.summary || "No stats"}\n${awayTeam.team.displayName}: ${awayTeam.records[0]?.summary || "No stats"}`;
        case "odds":
          const odds = competitions[0].odds?.[0];
          if (!odds) return "Sorry, odds data is unavailable.";
          return `Betting Odds:\n${homeTeam.team.displayName}: ${odds.homeTeamOdds?.summary || "N/A"}\n${awayTeam.team.displayName}: ${odds.awayTeamOdds?.summary || "N/A"}\nDraw: ${odds.drawOdds?.summary || "N/A"}`;
        default:
          return `I'm not sure how to handle that query. Try asking about scores, venue, team stats, or odds.`;
      }
    } catch (error) {
      console.error("Error processing match data:", error.message);
      return "Error processing match data. Please try again later.";
    }
  }

// Helper: Parse AI Response
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
          content: `You are a football assistant bot. Analyze queries and extract:
          1. The user's intent (e.g., "scores", "venue", "team_stats", "odds").
          2. The names of the two teams mentioned.
          Respond in the format:
          "User Intent: [intent]\nTeams: [team1], [team2]"`,
        },
        { role: "user", content: text },
      ],
    });

    const message = completion.choices[0].message.content;
    console.log("OpenAI Response:", message);
    return message;
  } catch (error) {
    console.error("Error processing query with OpenAI:", error.message);
    return "Sorry, I couldn't process your query.";
  }
}

// Respond to Original Cast
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
      console.log("Ignored event type:", event.type);
      return res.sendStatus(200);
    }

    const cast = event.data;
    const { text, hash } = cast;
    console.log(`Received mention: ${text} from cast hash: ${hash}`);

    const aiResponse = await processQueryWithOpenAI(text);

    const { intent, teams } = parseAIResponse(aiResponse);
    console.log("Parsed Intent:", intent);
    console.log("Parsed Teams:", teams);

    if (!teams || intent === "unknown") {
      await respondToCast(hash, "Sorry, I couldn't understand your query. Please ask about scores, venue, stats, or odds.");
      return res.sendStatus(200);
    }

    const [team1, team2] = teams;

    const match = await fetchESPNData(team1, team2);
    if (typeof match === "string") {
      await respondToCast(hash, match); // Handle error or no match found
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
