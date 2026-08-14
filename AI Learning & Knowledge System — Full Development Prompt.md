# AI Learning & Knowledge System — Full Development Prompt

## 1. Project Objective

Build a production-grade **AI Learning & Knowledge Management System** for an ISP Billing / Customer Support SaaS platform.

The goal is NOT to create a generic chatbot.

The goal is to create an **AI Support Executive** that can:

1. Learn multiple ISP software applications.
2. Learn software workflows and procedures.
3. Learn from human training sessions.
4. Learn from WhatsApp/customer conversations.
5. Learn from uploaded documents.
6. Learn new software requirements and feature changes.
7. Store all validated learning in a structured Knowledge Base.
8. Detect duplicate/similar knowledge and avoid repeated learning.
9. Answer customer queries using the Knowledge Base.
10. Provide relevant screenshots when necessary.
11. Support human approval before newly learned knowledge becomes active.
12. Support multiple AI providers and models through API.
13. Support AI ON/OFF control.
14. Support announcement generation and distribution.
15. Maintain complete learning history, versions, audit logs and source tracking.

The system must be designed so that the AI model is replaceable.

The **Knowledge Base belongs to our application**, not to the AI provider.

If we change Claude → OpenAI → Gemini later, our existing knowledge must remain intact.

---

# 2. Core Architecture

Use the following high-level architecture:

```text
Data Sources
    │
    ├── Software Demo
    ├── Human Training
    ├── WhatsApp Chats
    ├── Documents
    ├── Requirements
    └── Screenshots
            │
            ▼
     AI Learning Engine
            │
            ▼
   Normalize + Extract Knowledge
            │
            ▼
   Similarity / Duplicate Check
            │
       ┌────┴────┐
       │         │
    Existing    New
       │         │
      SKIP       ▼
              Learning
              Candidate
                 │
                 ▼
          Human Approval
                 │
                 ▼
          Knowledge Base
                 │
                 ▼
       AI Support Executive
                 │
                 ▼
       Customer / WhatsApp
```

---

# 3. Main Portal Module

Create a new main module:

## AI Learning

The sidebar should contain:

```text
AI Learning
├── Dashboard
├── Software Learning
├── Training Sessions
├── Chat Learning
├── Document Learning
├── Requirement Learning
├── Learning Candidates
├── Knowledge Base
├── Screenshots
├── Response Templates
├── Announcements
├── AI Providers
├── AI Models
├── Learning History
└── AI Settings
```

The UI must be modern, professional and suitable for an enterprise ISP management SaaS.

Do NOT create a generic AI chatbot-style UI.

---

# 4. AI Learning Dashboard

Create an executive dashboard showing:

### Statistics

- Total Knowledge
- Active Knowledge
- Inactive Knowledge
- Pending Learning Candidates
- Learned Software
- Training Sessions
- Documents Processed
- Chats Processed
- Screenshots Stored
- Duplicate Learning Skipped
- AI Requests
- Token Usage
- Estimated API Cost

### Activity

Show:

- Recent learning
- Recent approved knowledge
- Recent rejected knowledge
- Recent software learning
- Recent document learning
- Recent requirement learning

### AI Status

Display:

```text
AI Engine: ENABLED
Learning: ENABLED
Auto Response: ENABLED
Screenshot Response: ENABLED
```

with clear ON/OFF status.

---

# 5. Software Learning

Create a complete Software Learning module.

The admin can add multiple software applications.

Fields:

```text
Software Name
Description
Demo URL
Username
Password
Software Version
Login Type
Status
```

Credentials must be stored securely and encrypted.

Never expose passwords in normal UI.

Provide:

- Add Software
- Edit
- Delete
- Enable/Disable
- Test Login
- Start Learning
- Stop Learning
- Relearn
- View Learning History

---

# 6. Browser-Based Software Learning

The system should support browser automation for software learning.

Workflow:

```text
Start Learning
      ↓
Open Browser
      ↓
Open Demo URL
      ↓
Login
      ↓
Detect Dashboard
      ↓
Explore Navigation
      ↓
Explore Modules
      ↓
Explore Forms
      ↓
Explore Actions
      ↓
Capture Screenshots
      ↓
Extract Workflows
      ↓
Generate Learning Candidates
```

The AI should learn:

- Sidebar menus
- Submenus
- Pages
- Forms
- Fields
- Buttons
- Actions
- Tables
- Filters
- Search functions
- Settings
- Validation messages
- Error messages
- Workflow dependencies

Do not perform destructive actions during autonomous learning.

For example:

- Do not delete clients.
- Do not delete invoices.
- Do not change production settings.
- Do not send real messages.
- Do not modify financial records.

Use safe/read-only exploration whenever possible.

---

# 7. Human Training Mode

Create:

## Training Sessions

Admin can start:

**New Training Session**

Example:

```text
Training Name:
How to Suspend a Client

Software:
ISP Billing Software

Trainer:
Admin

Start Training
```

During training, the human performs the actual workflow.

Example:

```text
Client List
→ Search Client
→ Open Client
→ Action
→ Suspend
→ Confirm
```

The system records relevant:

- Steps
- URLs
- Page names
- Click actions
- Input fields
- Screenshots
- Human instructions

AI converts this into structured workflow knowledge.

After processing:

```text
Learning Candidate
```

is created.

Admin can:

- Approve
- Edit
- Reject

Only approved knowledge becomes active.

---

# 8. Learning Candidate System

Every new AI-generated learning should initially enter:

## Learning Candidates

Each candidate must contain:

```text
Candidate ID
Title
Category
Source Type
Source ID
Software
AI Model
Confidence
Similarity Score
Extracted Knowledge
Screenshots
Created At
Status
```

Statuses:

```text
Pending
Approved
Rejected
Needs Review
Duplicate
```

Actions:

- View
- Edit
- Approve
- Reject
- Mark Duplicate
- Compare with Existing Knowledge

---

# 9. Knowledge Base

Create a dedicated Knowledge Base.

This is the application's permanent AI knowledge storage.

Knowledge categories:

```text
Software
Workflow
FAQ
Troubleshooting
Customer Response
SOP
Requirement
Feature
Policy
Announcement
Screenshot
```

Each knowledge record should support:

```text
Knowledge ID
Title
Category
Question / Intent
Answer
Procedure
Software
Module
Version
Source
Confidence
AI Generated
Human Verified
Status
Created By
Created At
Updated At
```

Support:

- Search
- Filter
- Category
- Software
- Version
- Active/Inactive
- Source
- Confidence

Actions:

- View
- Edit
- Activate
- Deactivate
- Archive
- Version History

---

# 10. Knowledge Versioning

Never simply overwrite important knowledge.

Example:

```text
Knowledge:
Package Change Procedure

Version 1:
Admin approval required.

Version 2:
Automatic approval enabled.

Version 3:
Approval required only for specific packages.
```

Keep version history.

Only one version should be active at a time.

---

# 11. Active / Inactive Knowledge

Every knowledge item must have:

```text
ACTIVE
INACTIVE
```

If inactive:

- AI must not use it for customer responses.
- AI must not use it for automation.
- It remains available for historical reference.

Admin can reactivate it anytime.

---

# 12. Duplicate Learning Detection

This is mandatory.

When new information arrives:

```text
New Data
 ↓
AI Extract Knowledge
 ↓
Generate Embedding
 ↓
Vector Similarity Search
 ↓
Compare Existing Knowledge
```

If similarity is above configured threshold:

```text
Duplicate / Similar
→ SKIP
```

Do NOT create another knowledge record.

Example:

Customer asks:

> How can I suspend a client?

Existing knowledge:

> How to suspend a customer?

These should be recognized as semantically similar.

Store the new conversation as source/reference if needed, but do not create duplicate knowledge.

---

# 13. Learning Threshold Settings

Admin should be able to configure:

```text
Duplicate Similarity Threshold
Learning Confidence Threshold
Auto Approval Threshold
Human Review Threshold
```

Example:

```text
Similarity >= 95%
→ Skip

Confidence >= 90%
→ Can be auto-approved if enabled

Confidence 70–89%
→ Human Review

Confidence < 70%
→ Reject / Manual Review
```

These values must be configurable.

---

# 14. WhatsApp / Chat Learning

Create:

## Chat Learning

Support importing:

- WhatsApp chat exports
- Text files
- CSV
- JSON
- Conversation datasets

The system should extract:

```text
Customer Intent
Question
Correct Response
Procedure
Software
Module
Troubleshooting
Escalation
```

Do not blindly learn every sentence.

The AI must identify reusable knowledge.

---

# 15. Live Chat Learning

For live WhatsApp conversations:

```text
Incoming Chat
      ↓
Normalize
      ↓
Detect Intent
      ↓
Search Knowledge
      ↓
Similarity Check
      ↓
Existing?
   YES → Skip Learning
   NO  → Generate Candidate
```

Do not repeatedly learn the same question every time customers ask it.

---

# 16. Document Learning

Create:

## Document Learning

Allow upload of:

- PDF
- DOCX
- TXT
- Markdown
- CSV
- JSON

Workflow:

```text
Upload
 ↓
Extract Text
 ↓
Chunk Content
 ↓
AI Analysis
 ↓
Knowledge Extraction
 ↓
Embedding
 ↓
Duplicate Detection
 ↓
Learning Candidate
```

Show processing progress.

---

# 17. Screenshot Knowledge

Screenshots are first-class knowledge assets.

Each screenshot should have:

```text
Screenshot ID
Knowledge ID
Software
Module
Step
Image
Description
Version
Status
Created At
```

Example:

```text
Knowledge:
How to Generate Invoice

Step 1:
Open Billing

Screenshot

Step 2:
Open Invoice

Screenshot

Step 3:
Click Generate

Screenshot
```

When the customer asks for visual guidance, the AI can return the relevant screenshots.

---

# 18. Customer Support AI

Build an AI Support Executive.

Flow:

```text
Customer Message
       ↓
Intent Detection
       ↓
Knowledge Retrieval
       ↓
Relevant Knowledge
       ↓
Confidence Check
       ↓
Generate Response
       ↓
Optional Screenshot
       ↓
Send Response
```

The AI must prioritize verified active knowledge.

Priority:

```text
Human Verified Knowledge
        ↓
Approved Knowledge
        ↓
High Confidence AI Knowledge
        ↓
Other Sources
```

---

# 19. No Hallucination Rule

If the Knowledge Base does not contain sufficient information:

Do NOT invent an answer.

Instead:

```text
Insufficient Knowledge
        ↓
Human Escalation
```

The AI should say internally:

```text
Knowledge confidence too low.
Human support required.
```

Customer-facing wording should be configured separately.

---

# 20. Response Learning

The system should learn not only WHAT to answer but also HOW support executives answer.

Extract:

- Tone
- Structure
- Greeting
- Technical explanation
- Step-by-step format
- Escalation style
- Closing style

Create:

## Response Templates

Examples:

```text
Technical Issue
Billing Issue
Requirement
Feature Request
Network Issue
MikroTik Issue
OLT Issue
General Support
```

Templates can be edited manually.

---

# 21. Requirement Learning

Create:

## Requirement Learning

Admin can enter or upload new requirements.

Example:

```text
Old Behaviour:
Package change required approval.

New Requirement:
Package change should be automatically approved.
```

AI should:

1. Read requirement.
2. Compare with existing knowledge.
3. Identify affected knowledge.
4. Create updated version.
5. Show changes.
6. Ask for approval.
7. Activate new version.

Never silently overwrite existing knowledge.

---

# 22. Announcement System

Create:

## Announcements

Admin can create:

```text
Title
Release Version
Feature
Description
Target Groups
Schedule
Status
```

AI can generate announcement content from release information.

Workflow:

```text
Release Information
       ↓
AI Announcement Draft
       ↓
Admin Review
       ↓
Approve
       ↓
Send to Selected WhatsApp Groups
```

AI must never invent release information.

---

# 23. AI Provider Management

Create:

## AI Providers

Support multiple providers.

Examples:

```text
Anthropic
OpenAI
Google
Custom API
```

Each provider:

```text
Provider Name
API URL
API Key
Status
Priority
```

API keys must be encrypted.

Never expose full API keys in frontend.

---

# 24. AI Model Management

Create:

## AI Models

Allow selecting models for different jobs:

```text
Learning Model
Response Model
Vision Model
Document Model
Embedding Model
```

Example:

```text
Learning:
Claude

Response:
OpenAI

Vision:
Vision-capable model

Embedding:
Configured embedding model
```

Do not hard-code a single AI provider.

Use a provider abstraction layer.

---

# 25. AI Enable / Disable

Create master control:

```text
AI Engine
ON / OFF
```

Also:

```text
Learning
ON / OFF

Auto Response
ON / OFF

Screenshot Response
ON / OFF

Chat Learning
ON / OFF

Software Learning
ON / OFF

Requirement Learning
ON / OFF

Announcement AI
ON / OFF
```

When AI Engine is OFF, the existing normal automation must continue working.

---

# 26. AI Usage & Cost Tracking

Track:

```text
Provider
Model
Request Type
Input Tokens
Output Tokens
Total Tokens
Estimated Cost
User
Timestamp
```

Dashboard:

```text
Today
This Week
This Month
```

Show estimated API cost.

---

# 27. Learning History

Create complete audit history.

Track:

```text
What was learned
From where
When
Which model
Which provider
Confidence
Similarity
Who approved
Who edited
What changed
```

This is essential for debugging.

---

# 28. Database Architecture

Use a relational database for application data.

Recommended:

```text
PostgreSQL
```

Use vector search through:

```text
pgvector
```

Core tables/entities:

```text
ai_providers
ai_models
ai_settings

software_apps
software_credentials
software_learning_sessions

training_sessions
training_events

learning_sources
learning_candidates

knowledge_base
knowledge_versions
knowledge_embeddings

knowledge_screenshots

chat_sources
chat_messages

documents
document_chunks

requirements
requirement_versions

response_templates

announcements
announcement_targets

ai_requests
ai_usage

learning_history
audit_logs
```

Use proper foreign keys and indexes.

---

# 29. Security

This system will contain sensitive credentials.

Implement:

- Encryption at rest for credentials
- API key encryption
- Role-based access control
- Audit logging
- Password masking
- No credentials in logs
- Secure browser sessions
- Session timeout
- Permission checks

Never expose software passwords or API keys to the AI unnecessarily.

Only provide credentials to the browser automation layer when required.

---

# 30. AI Should NOT Have Unlimited Access

Use scoped permissions.

Example:

```text
AI Learning:
READ software pages

AI Automation:
ALLOWED specific workflows

AI Support:
READ knowledge

AI Announcement:
CREATE draft

AI Production Action:
REQUIRES explicit permission
```

Destructive operations should require confirmation.

---

# 31. Technology Requirements

Use the existing project's technology stack where possible.

Recommended architecture:

### Frontend

```text
Next.js
TypeScript
TailwindCSS
shadcn/ui
```

### Backend

```text
NestJS
TypeScript
Prisma
PostgreSQL
Redis
BullMQ
```

### AI

Use provider abstraction:

```text
AIProviderInterface
```

Implement adapters:

```text
AnthropicProvider
OpenAIProvider
GoogleProvider
CustomProvider
```

### Vector Search

```text
PostgreSQL + pgvector
```

### Background Jobs

Use:

```text
Redis + BullMQ
```

for:

- Document processing
- Embedding generation
- Chat learning
- Software learning
- Screenshot processing
- Duplicate detection
- AI tasks

---

# 32. Important Engineering Rule

Do NOT build everything as one giant AI prompt.

Use separate services:

```text
AI Gateway
Learning Engine
Knowledge Service
Embedding Service
Document Processor
Browser Automation Service
Chat Analyzer
Response Generator
Screenshot Service
Announcement Service
```

This keeps the system maintainable.

---

# 33. Knowledge Retrieval

For customer questions use hybrid retrieval:

```text
Keyword Search
+
Vector Similarity
+
Metadata Filtering
+
Software Filtering
+
Version Filtering
+
Active Status
```

Only active and relevant knowledge should normally be retrieved.

---

# 34. AI Response Generation

Prompt the AI with only the relevant knowledge.

Example internal context:

```text
Customer Question

Relevant Knowledge:
1. KB-1001
2. KB-1045
3. KB-1102

Software:
ISP Billing v3

Current Version:
3.2

Relevant Screenshots:
Screenshot-22
Screenshot-24
```

Then generate the response.

Do not send the entire Knowledge Base to the AI.

---

# 35. Learning Pipeline

Every source should follow:

```text
SOURCE
 ↓
INGEST
 ↓
NORMALIZE
 ↓
EXTRACT
 ↓
CLASSIFY
 ↓
EMBED
 ↓
SIMILARITY CHECK
 ↓
VALIDATE
 ↓
CANDIDATE
 ↓
HUMAN APPROVAL
 ↓
KNOWLEDGE VERSION
 ↓
ACTIVE
```

This should be the standard learning pipeline.

---

# 36. UI/UX Requirements

The interface must feel like a professional enterprise application.

Avoid:

- Generic AI chatbot UI
- Excessive gradients
- Random cards
- Huge empty spaces
- Decorative components without purpose

Use:

- Clear data tables
- Filters
- Search
- Status badges
- Side panels
- Detail drawers
- Tabs
- Timeline
- Version history
- Approval actions
- Clear forms
- Confirmation dialogs

The UI should prioritize usability and operational efficiency.

---

# 37. Development Strategy

Do NOT try to implement everything in one step.

Implement in phases.

## Phase 1

Build:

```text
Database
AI Settings
AI Providers
AI Models
Knowledge Base
Knowledge Versioning
Audit Logs
```

## Phase 2

Build:

```text
Software Learning
Browser Automation
Training Sessions
Learning Candidates
```

## Phase 3

Build:

```text
Document Learning
Chat Learning
Duplicate Detection
Embedding
Vector Search
```

## Phase 4

Build:

```text
AI Support Executive
Knowledge Retrieval
Response Generation
Screenshot Response
Human Escalation
```

## Phase 5

Build:

```text
Requirement Learning
Announcement System
WhatsApp Integration
```

## Phase 6

Build:

```text
AI Analytics
Token Tracking
Cost Tracking
Advanced Permissions
Optimization
```

---

# 38. Acceptance Criteria

The implementation is considered successful only when all of the following work:

### Software Learning

- Admin can add multiple software.
- Credentials are securely stored.
- AI can start a learning session.
- Browser automation can access the demo.
- Learning results are generated.
- Screenshots can be stored.
- Learning candidates are created.

### Knowledge

- Admin can approve/reject candidates.
- Approved knowledge becomes active.
- Knowledge can be edited.
- Knowledge can be deactivated.
- Knowledge can be versioned.
- Old versions remain available.

### Duplicate Detection

- Similar information is detected.
- Duplicate learning is skipped.
- Similarity score is visible.

### Documents

- Documents can be uploaded.
- AI extracts knowledge.
- Duplicate information is skipped.

### Chat

- Chat data can be imported.
- AI extracts reusable knowledge.
- Duplicate conversations do not create duplicate knowledge.

### AI Support

- Customer question is analyzed.
- Relevant knowledge is retrieved.
- Correct answer is generated.
- Relevant screenshot can be attached.
- Low-confidence queries are escalated.

### AI Controls

- AI can be enabled/disabled.
- Learning can be enabled/disabled.
- Multiple providers can be configured.
- Multiple models can be configured.

### Security

- Credentials are encrypted.
- API keys are encrypted.
- Sensitive information is not logged.
- All important actions are audited.

---

# 39. Critical Rule

Do not remove or break existing application functionality.

Before changing existing code:

1. Inspect the current architecture.
2. Identify existing modules.
3. Identify existing database structure.
4. Identify existing WhatsApp integration.
5. Identify existing automation.
6. Reuse existing services where appropriate.
7. Add the AI system modularly.

Do not rewrite the entire application unnecessarily.

---

# 40. First Task

Before writing implementation code:

### Step 1

Inspect the existing project completely.

Identify:

- Frontend framework
- Backend framework
- Database
- Authentication
- Existing WhatsApp integration
- Existing automation
- Existing API architecture
- Existing modules
- Existing database models
- Existing background jobs
- Existing deployment setup

### Step 2

Create an implementation plan based on the existing architecture.

### Step 3

Create database schema/migrations.

### Step 4

Implement AI Provider abstraction.

### Step 5

Implement Knowledge Base.

### Step 6

Implement Learning Candidate workflow.

### Step 7

Implement Software Learning.

Do not skip directly to the chatbot.

---

# Final Product Vision

The final system should behave like a trained human support executive:

```text
Software Knowledge
        +
Human Training
        +
Previous Customer Chats
        +
Documents
        +
Requirements
        +
Screenshots
        ↓
   AI Learning Engine
        ↓
   Knowledge Base
        ↓
   AI Support Executive
        ↓
Customer Query
        ↓
Correct Answer
        +
Relevant Screenshot
        +
Correct Software Procedure
```

The system should continuously improve, but it must avoid duplicate learning, hallucinated knowledge and uncontrolled changes.

The application should remain the source of truth.

The AI should be the intelligence layer operating on top of the application's Knowledge Base.

Start by inspecting the existing project and provide the current architecture, then implement Phase 1 without breaking existing functionality.