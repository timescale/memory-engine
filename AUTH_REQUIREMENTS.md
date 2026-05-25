Let's design an permission system for a memory system that stores textual memories (documents):
- is multi-tenant where each tenenant is a memory collection
- is meant to allow people to store their own memories or to share memories across projects/companies
- would support both humans and their ai agents
    - where agents have access to a non-strict subset of their user's memories 
- humans (and maybe agents) should have a "private" section in a collection that other user's don't see. Admin's don't see this section by default but can in "sudo" mode. 
- would be simple to understand for easy use-cases and possible for more complex permission arrangments
- the implementation can start simple and be extensible.

Think hard about:
- whether users are global or per-collections
- whether assigned permissions are global or per-collection
- do we want user groups? are they global or per-collection
- what analogy/mental model people can use to easily understand permissions

Research how similar systems do things: Notion,google drive, wiki systems,  any others? what do people love/hate?
