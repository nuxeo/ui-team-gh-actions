# About ui-team-gh-actions

This repository contains Github Actions shared between workflows used by the UI team to support the CI/CD for [Nuxeo Web UI](https://github.com/nuxeo/nuxeo-web-ui) and [Nuxeo Elements](https://github.com/nuxeo/nuxeo-elements).

## Contents

- [`get-branch`](get-branch/action.yaml): picks the branch to check out in a repository, or its default branch.
- [`trigger-workflow`](trigger-workflow/action.yaml): triggers a workflow run through the dispatch event and waits for its result.
- [`dependabot-ai-triage`](dependabot-ai-triage/README.md): reusable workflow ([`.github/workflows/dependabot-ai-triage.yaml`](.github/workflows/dependabot-ai-triage.yaml)) for the weekly AI-assisted triage of Dependabot alerts in Nuxeo Web UI and Nuxeo Elements into Jira and Teams. It is scheduled from Nuxeo Web UI.

## License

[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt)

(C) Copyright Nuxeo Corp. (http://nuxeo.com/)

All images, icons, fonts, and videos contained in this folder are copyrighted by Nuxeo, all rights reserved.

## About Nuxeo
Nuxeo dramatically improves how content-based applications are built, managed and deployed, making customers more agile, innovative and successful. Nuxeo provides a next generation, enterprise ready platform for building traditional and cutting-edge content oriented applications. Combining a powerful application development environment with SaaS-based tools and a modular architecture, the Nuxeo Platform and Products provide clear business value to some of the most recognizable brands including Verizon, Electronic Arts, Sharp, FICO, the U.S. Navy, and Boeing. Nuxeo is headquartered in New York and Paris. More information is available at [www.nuxeo.com](http://www.nuxeo.com).