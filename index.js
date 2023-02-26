/* ================================================================================

	notion-github-sync.
  
  Glitch example: https://glitch.com/edit/#!/notion-github-sync
  Find the official Notion API client @ https://github.com/makenotion/notion-sdk-js/

================================================================================ */

const { Client } = require("@notionhq/client");
const dotenv = require("dotenv");
const { Octokit } = require("octokit");
const _ = require("lodash");
const { assign } = require("lodash");

dotenv.config();
const octokit = new Octokit({ auth: process.env.GITHUB_KEY });
const notion = new Client({ auth: process.env.NOTION_KEY });

const taskDatabaseID = process.env.NOTION_DATABASE_TASKS_ID;
const projectsDatabaseID = process.env.NOTION_DATABASE_PROJECTS_ID;
const repos = process.env.GITHUB_REPO_NAMES?.split(",");
const projectNames = process.env.REPO_PROJECT_NAMES?.split(",");
const OPERATION_BATCH_SIZE = 10;

const gitHubIssuesIdToNotionPageId = [];
setInitialGitHubToNotionIdMap().then(syncNotionDatabaseWithGitHub);

async function setInitialGitHubToNotionIdMap() {
  const currentIssues = await getIssuesFromNotionDatabase();
  for (const obj of currentIssues) {
    gitHubIssuesIdToNotionPageId.push(obj);
  }
}

async function syncNotionDatabaseWithGitHub() {
  // Get all issues currently in the provided GitHub repository.
  const users = await getUserList();
  const projects = await getProjects();
  await repos?.forEach(async (repo, idx) => {
    console.log(`\nFetching issues from GitHub repository ${repo} ...`);
    const issues = await getGitHubIssuesForRepository(repo);
    console.log(`Fetched ${issues.length} issues from GitHub repository.`);
    // Group issues into those that need to be created or updated in the Notion database.
    const { pagesToCreate, pagesToUpdate } = getNotionOperations(issues, repo);

    // Create pages for new issues.
    console.log(`\n${pagesToCreate.length} new issues to add to Notion.`);
    const repoProject = projects.find(({ name }) => name === projectNames[idx]);
    await createPages(pagesToCreate, users, repoProject.id, repo);

    // Updates pages for existing issues.
    console.log(`\n${pagesToUpdate.length} issues to update in Notion.`);
    await updatePages(pagesToUpdate, users, repoProject.id, repo);
  });

  // Success!
}

async function getIssuesFromNotionDatabase() {
  const pages = await getPages(taskDatabaseID);
  const issues = [];
  for (const page of pages) {
    var pageTitle = page.properties.Task.title[0].text.content;
    const regexp = /(.{1,})#(\w{1,}):/g;
    const matches = regexp.exec(pageTitle);
    if (matches) {
      issues.push({
        pageId: page.id,
        issueNumber: parseInt(matches[2]),
        projectID: page.properties.Projects.relation[0].id,
        repo: matches[1],
      });
    }
  }

  return issues;
}

async function getProjects() {
  let projects = [];
  const pages = await getPages(projectsDatabaseID);
  pages.forEach((obj) => {
    if (obj.properties.Name.title.length != 0) {
      projects.push({
        id: obj.id,
        name: obj.properties.Name.title[0].text.content,
      });
    }
  });
  return projects;
}

async function getPages(dbID) {
  const pages = [];
  let cursor = undefined;
  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: dbID,
      start_cursor: cursor,
    });
    pages.push(...results);
    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }
  return pages;
}

async function getUserList() {
  const users = [];
  let cursor = undefined;
  while (true) {
    const { results, next_cursor } = await notion.users.list({
      start_cursor: cursor,
    });
    users.push(...results);
    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }
  return users;
}

async function getGitHubIssuesForRepository(repo) {
  const issues = [];
  const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner: process.env.GITHUB_REPO_OWNER,
    repo: repo,
    state: "all",
    per_page: 100,
  });
  for await (const { data } of iterator) {
    for (const issue of data) {
      if (!issue.pull_request) {
        issues.push({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          comment_count: issue.comments,
          url: issue.html_url,
          assignees: issue.assignees,
        });
      }
    }
  }
  return issues;
}

function getNotionOperations(issues, repository) {
  const pagesToCreate = [];
  const pagesToUpdate = [];
  const notionIssues = gitHubIssuesIdToNotionPageId.filter(
    ({ repo }) => repo === repository
  );
  for (const issue of issues) {
    const obj = notionIssues.find(
      ({ issueNumber }) => issueNumber === issue.number
    );
    if (obj) {
      const pageId = obj.pageID;
      if (pageId) {
        pagesToUpdate.push({
          ...issue,
          pageId,
        });
      }else{
        pagesToCreate.push(issue);  
      }
    } else {
      pagesToCreate.push(issue);
    }
  }

  return { pagesToCreate, pagesToUpdate };
}

async function createPages(pagesToCreate, users, project, repo) {
  const pagesToCreateChunks = _.chunk(pagesToCreate, OPERATION_BATCH_SIZE);
  for (const pagesToCreateBatch of pagesToCreateChunks) {
    await Promise.all(
      pagesToCreateBatch.map((issue) =>
        notion.pages.create({
          parent: { database_id: taskDatabaseID },
          properties: getPropertiesFromIssue(issue, users, project, repo),
        })
      )
    );
    console.log(`Completed batch size: ${pagesToCreateBatch.length}`);
  }
}

async function updatePages(pagesToUpdate, users, project, repo) {
  const pagesToUpdateChunks = _.chunk(pagesToUpdate, OPERATION_BATCH_SIZE);
  for (const pagesToUpdateBatch of pagesToUpdateChunks) {
    await Promise.all(
      pagesToUpdateBatch.map(({ pageId, ...issue }) =>
        notion.pages.update({
          page_id: pageId,
          properties: getPropertiesFromIssue(issue, users, project, repo),
        })
      )
    );
    console.log(`Completed batch size: ${pagesToUpdateBatch.length}`);
  }
}

function getPropertiesFromIssue(issue, users, project, repo) {
  const { title, number } = issue;
  return {
    Task: {
      title: [
        { type: "text", text: { content: `${repo}#${number}: ${title}` } },
      ],
    },
    Status: {
      status: { name: getIssueStatus(issue) },
    },
    Assign: {
      people: getAssignees(issue, users),
    },
    Projects: {
      relation: [{ id: project }],
    },
  };
}

function getIssueStatus(issue) {
  if (issue.state === "closed") {
    return "Done";
  } else {
    if (issue.assignees.length != 0) {
      return "In progress";
    } else {
      return "Not started";
    }
  }
}
function getAssignees(issue, users) {
  var assignees = [];
  var github_usernames = process.env.GITHUB_USERNAMES?.split(",");
  var notion_usernames = process.env.NOTION_USERNAMES?.split(",");
  if (notion_usernames === undefined) return [];
  issue.assignees.forEach((assigne) => {
    var index = github_usernames?.indexOf(assigne.login);
    if (index != -1 && index != undefined) {
      var usr = users.find(
        (element) => element.name === notion_usernames[index]
      );
      if (usr != undefined) {
        assignees.push({ id: usr.id });
      }
    }
  });
  return assignees;
}
