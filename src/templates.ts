/** Collaboration mode determines how workers interact. */
export type CollaborationMode = "pipeline" | "mapreduce" | "supervisor";

export type WorkerSpec = {
  id: string;
  role: string;
  responsibility: string;
};

export type TeamTemplate = {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  leader: {
    role: string;
    personality: string;
    coreInstruction: string;
  };
  workers: WorkerSpec[];
  collaborationMode: CollaborationMode;
  modeInstruction: string;
};

export const TEMPLATES: TeamTemplate[] = [
  {
    id: "deep-research",
    name: "Deep Research",
    description: "Parallel search and investigation on multiple aspects of a topic, followed by synthesis.",
    keywords: ["search", "investigate", "find", "lookup", "query", "discover", "research", "scan", "browse", "research", "investigate", "survey", "literature", "study", "explore", "deep dive"],
    leader: {
      role: "Research Coordinator",
      personality: "Organized, strategic, excellent at synthesizing disparate information sources into coherent narratives.",
      coreInstruction:
        "Divide the research task into two specific sub-topics or angles, assign these to two search-focused workers in parallel, then synthesize all findings into a comprehensive final report. Limit each search worker to maximum 3 sources/results to maintain focus and efficiency.",
    },
    workers: [
      {
        id: "search-specialist-1",
        role: "Search Specialist 1",
        responsibility: "Conduct targeted research on first aspect of the topic, find 1-3 key sources.",
      },
      {
        id: "search-specialist-2",
        role: "Search Specialist 2",
        responsibility: "Conduct targeted research on second aspect of the topic, find 1-3 key sources.",
      },
      {
        id: "report-writer",
        role: "Report Writer",
        responsibility: "Create comprehensive research report based on all search specialists' findings, synthesizing information into cohesive narrative with proper citations.",
      },
    ],
    collaborationMode: "mapreduce",
    modeInstruction:
      "Map phase: Run both search specialists in parallel, each focusing on different aspects/angles of the research topic (limit each to 3 sources). Reduce phase: Report writer combines all findings to create final comprehensive report.",
  },
  {
    id: "content-creation",
    name: "Content Creation",
    description: "Research-write-review pipeline for polished content.",
    keywords: ["write", "article", "blog", "content", "copy", "draft", "essay", "report"],
    leader: {
      role: "Editorial Director",
      personality: "Creative yet disciplined, focuses on clarity and audience engagement.",
      coreInstruction:
        "Manage a content pipeline. Have the researcher gather background material, then the writer drafts content using those materials, and finally the reviewer polishes and quality-checks the output.",
    },
    workers: [
      {
        id: "researcher",
        role: "Researcher",
        responsibility:
          "Gather background information, key facts, and reference material for the topic.",
      },
      {
        id: "writer",
        role: "Writer",
        responsibility:
          "Draft well-structured content based on research, matching the requested tone and format.",
      },
      {
        id: "reviewer",
        role: "Reviewer",
        responsibility:
          "Review drafts for accuracy, clarity, grammar, and adherence to requirements.",
      },
    ],
    collaborationMode: "pipeline",
    modeInstruction:
      "Run workers sequentially: researcher → writer → reviewer. Each stage builds on the previous output.",
  },
  {
    id: "data-analysis",
    name: "Data Analysis",
    description: "Collect, analyze, and visualize data in a structured pipeline.",
    keywords: [
      "data",
      "analyze",
      "statistics",
      "metrics",
      "chart",
      "visualization",
      "numbers",
      "trends",
    ],
    leader: {
      role: "Data Lead",
      personality: "Precision-oriented, insists on clean methodology and reproducible results.",
      coreInstruction:
        "Orchestrate data analysis: have the collector gather and clean data, pass to the analyst for statistical analysis and insight extraction, then to the visualizer for presentation-ready output.",
    },
    workers: [
      {
        id: "data-collector",
        role: "Data Collector",
        responsibility: "Gather, clean, and structure raw data from specified sources.",
      },
      {
        id: "analyst",
        role: "Analyst",
        responsibility:
          "Perform statistical analysis, identify trends, and extract actionable insights.",
      },
      {
        id: "visualizer",
        role: "Visualizer",
        responsibility: "Create clear summaries, tables, and descriptions of data visualizations.",
      },
    ],
    collaborationMode: "pipeline",
    modeInstruction:
      "Run workers sequentially: data-collector → analyst → visualizer. Each stage refines and builds on prior output.",
  },
  {
    id: "competitive-analysis",
    name: "Competitive Analysis",
    description: "Parallel research on multiple subjects, merged into a comparative report.",
    keywords: [
      "compare",
      "competitive",
      "benchmark",
      "versus",
      "comparison",
      "market",
      "landscape",
    ],
    leader: {
      role: "Strategy Director",
      personality: "Analytical, big-picture thinker, skilled at comparative frameworks.",
      coreInstruction:
        "Run parallel researchers on different subjects, then merge findings through an analyst, and have the reporter compile a comparative report with actionable recommendations.",
    },
    workers: [
      {
        id: "researcher-a",
        role: "Researcher A",
        responsibility: "Deep-dive research on the first subject or competitor.",
      },
      {
        id: "researcher-b",
        role: "Researcher B",
        responsibility: "Deep-dive research on the second subject or competitor.",
      },
      {
        id: "analyst",
        role: "Analyst",
        responsibility:
          "Merge parallel research outputs, identify differentiators and commonalities.",
      },
      {
        id: "reporter",
        role: "Reporter",
        responsibility: "Compile a structured comparative report with recommendations.",
      },
    ],
    collaborationMode: "mapreduce",
    modeInstruction:
      "Map phase: run researcher-a and researcher-b in parallel. Reduce phase: pass both outputs to analyst, then to reporter.",
  },
  {
    id: "brainstorm",
    name: "Brainstorm",
    description: "Parallel perspectives from optimist, critic, and pragmatist.",
    keywords: ["brainstorm", "ideate", "ideas", "creative", "innovate", "options", "possibilities"],
    leader: {
      role: "Facilitator",
      personality: "Balanced, encourages diverse viewpoints, skilled at synthesis.",
      coreInstruction:
        "Run all three perspectives in parallel on the same prompt, then synthesize their outputs into a balanced recommendation that incorporates the best ideas while addressing concerns.",
    },
    workers: [
      {
        id: "optimist",
        role: "Optimist",
        responsibility:
          "Explore the most ambitious possibilities, highlight opportunities and upside potential.",
      },
      {
        id: "critic",
        role: "Critic",
        responsibility:
          "Identify risks, potential failures, edge cases, and weaknesses in proposed ideas.",
      },
      {
        id: "pragmatist",
        role: "Pragmatist",
        responsibility: "Focus on feasibility, implementation complexity, and practical tradeoffs.",
      },
    ],
    collaborationMode: "mapreduce",
    modeInstruction:
      "Map phase: run optimist, critic, and pragmatist in parallel on the same task. Reduce phase: Leader synthesizes all perspectives.",
  },
];

/**
 * Score a template against a task description by counting keyword hits.
 * Returns a value between 0 and 1.
 */
export function scoreTemplate(template: TeamTemplate, task: string): number {
  const lower = task.toLowerCase();
  const hits = template.keywords.filter((kw) => lower.includes(kw)).length;
  return template.keywords.length > 0 ? hits / template.keywords.length : 0;
}

/** Rank templates by relevance to a task, best first. */
export function rankTemplates(task: string): Array<{ template: TeamTemplate; score: number }> {
  return TEMPLATES.map((template) => ({
    template,
    score: scoreTemplate(template, task),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}
