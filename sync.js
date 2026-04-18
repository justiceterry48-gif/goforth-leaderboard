const fs = require('fs');

// Credentials come from GitHub Secrets — never hardcoded
const GROUP_ID     = process.env.GROUP_ID;
const API_KEY      = process.env.API_KEY;
const CHALLENGE_ID = 58723;
const START        = '2026-05-01';  // UPDATE for each new challenge
const END          = '2026-05-31';  // UPDATE for each new challenge
const DAYS         = 30;           // UPDATE for each new challenge

const LOC_TAGS = {
  'go-forth high point':        'High Point',
  'go-forth raleigh':           'Raleigh',
  'go-forth charlotte':         'Charlotte',
  'go-forth lake norman':       'Lake Norman',
  'go-forth wilmington':        'Wilmington',
  'go-forth hickory':           'Hickory',
  'go-forth columbia':          'Columbia',
  'go-forth richmond':          'Richmond',
  'go-forth virginia beach':    'Virginia Beach',
  'go-forth northern virginia': 'Northern Virginia',
};

const BASE  = 'https://api.trainerize.com/v03';
const AUTH  = Buffer.from(GROUP_ID + ':' + API_KEY).toString('base64');
const HEADS = {
  'Authorization': 'Basic ' + AUTH,
  'Content-Type':  'application/json',
  'Accept':        'application/json',
};

async function post(endpoint, body) {
  const res  = await fetch(BASE + endpoint, {
    method: 'POST', headers: HEADS,
    body:   JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(res.status + ' on ' + endpoint);
  try { return JSON.parse(text); }
  catch(e) { throw new Error('Non-JSON from ' + endpoint); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function dayNumber() {
  const diff = Math.floor((new Date() - new Date(START)) / 86400000);
  return Math.max(1, Math.min(diff + 1, DAYS));
}

async function getParticipants() {
  console.log('Fetching participants...');
  let all = [], start = 0;
  const count = 50;

  while (true) {
    const data = await post('/challenge/getLeaderboardParticipantList', {
      challengeID: CHALLENGE_ID, start, count, reversed: 'false',
    });
    const list = data.participants || data.users || data.clients || data.data || [];
    if (!Array.isArray(list) || list.length === 0) break;
    all = all.concat(list);
    if (list.length < count) {
      const check = await post('/challenge/getLeaderboardParticipantList', {
        challengeID: CHALLENGE_ID, start: all.length, count, reversed: 'false',
      });
      const more = check.participants || check.users || check.clients || check.data || [];
      if (Array.isArray(more) && more.length > 0) {
        all = all.concat(more);
        start = all.length;
        if (more.length < count) break;
      } else break;
    } else { start += count; }
    await delay(150);
  }

  const seen = new Set();
  const unique = all.filter(p => {
    const id = p.userID || p.id;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
  console.log('Total participants: ' + unique.length);
  return unique;
}

async function getUserLocation(userID) {
  try {
    const data = await post('/userTag/getList', { userID });
    const tags = data.userTags || data.tags || data.data || data || [];
    if (!Array.isArray(tags)) return 'Unassigned';
    for (const tag of tags) {
      const tagName = (tag.name || tag.tag || '').toLowerCase().trim();
      if (LOC_TAGS[tagName]) return LOC_TAGS[tagName];
    }
    return 'Unassigned';
  } catch(e) { return 'Unassigned'; }
}

async function main() {
  if (!GROUP_ID || !API_KEY) {
    console.error('ERROR: GROUP_ID and API_KEY must be set as GitHub Secrets');
    process.exit(1);
  }

  console.log('=== GOFORTH LEADERBOARD SYNC ===');
  console.log(new Date().toLocaleString());
  console.log('Challenge: ' + CHALLENGE_ID);
  console.log('Dates: ' + START + ' to ' + END);

  const day          = dayNumber();
  const participants = await getParticipants();
  if (participants.length === 0) { console.log('No participants!'); process.exit(1); }

  console.log('\nFetching location tags...');
  const people = [];

  for (let i = 0; i < participants.length; i++) {
    const p      = participants[i];
    const id     = p.userID || p.id;
    const name   = (p.name || '').trim() || 'Employee ' + (i+1);
    const points = p.points || 0;
    const location = await getUserLocation(id);

    people.push({ id, name, points, location, email: p.email || '' });
    if ((i+1) % 20 === 0) console.log('  Processed ' + (i+1) + '/' + participants.length);
    await delay(150);
  }

  // Build location summaries
  const locMap = {};
  people.forEach(p => {
    const loc = p.location || 'Unassigned';
    if (!locMap[loc]) locMap[loc] = { name: loc, members: [], totalPts: 0 };
    locMap[loc].members.push(p);
    locMap[loc].totalPts += p.points;
  });

  const locations = Object.values(locMap).map(loc => ({
    name:         loc.name,
    memberCount:  loc.members.length,
    totalPts:     loc.totalPts,
    ptsPerPerson: loc.members.length > 0 ? Math.round(loc.totalPts / loc.members.length) : 0,
    compRate:     loc.members.length > 0
      ? Math.round((loc.members.filter(m => m.points > 0).length / loc.members.length) * 100) : 0,
    topScore:     Math.max(...loc.members.map(m => m.points), 0),
    members:      [...loc.members].sort((a,b) => b.points - a.points),
  })).sort((a,b) => b.totalPts - a.totalPts);

  const output = {
    lastUpdated:        new Date().toISOString(),
    challengeDay:       day,
    totalDays:          DAYS,
    startDate:          START,
    endDate:            END,
    challengeID:        CHALLENGE_ID,
    totalParticipants:  people.length,
    totalPoints:        people.reduce((s,p) => s + p.points, 0),
    activeParticipants: people.filter(p => p.points > 0).length,
    locations,
    individuals:        [...people].sort((a,b) => b.points - a.points),
  };

  fs.writeFileSync('leaderboard_data.json', JSON.stringify(output, null, 2));

  console.log('\n=== SYNC COMPLETE ===');
  console.log('Participants: ' + people.length);
  console.log('Active: ' + output.activeParticipants);
  console.log('Total points: ' + output.totalPoints);
  console.log('Day: ' + day + ' of ' + DAYS);

  console.log('\nSTANDINGS:');
  locations.forEach((loc, i) => {
    const m = ['🥇','🥈','🥉'][i] || '  ';
    console.log(m + ' ' + loc.name + ' — ' + loc.totalPts + ' pts (' + loc.memberCount + ' people)');
  });
}

main().catch(err => {
  console.error('SYNC FAILED:', err.message);
  process.exit(1);
});
