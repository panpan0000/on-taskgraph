// Copyright 2014, Renasar Technologies Inc.  /* jshint node:true */

'use strict';

require('../helper');

var di = require('di');
var _ = require('lodash');
var Q = require('q');
var tasks = require('renasar-tasks');

function literalCompare(objA, objB) {
    _.forEach(objA, function(v, k) {
        if (typeof v === 'object' && !(v instanceof Date)) {
            literalCompare(v, objB[k]);
        } else {
            expect(v).to.deep.equal(objB[k]);
        }
    });
}

// The only values currently that won't compare accurately from JSON to
// object are Date objects, so do some manual conversion there.
function deserializeJson(json) {
    _.forEach(json, function(v, k) {
        if (!_.contains(['tasks', 'finishedTasks', 'pendingTasks'], k)) {
            return;
        }
        _.forEach(v, function(_v, _k) {
            _.forEach(_v.stats, function(__v, __k) {
                if (__v) {
                    v[_k].stats[__k] = new Date(__v);
                }
            });

        });
    });
}

function cleanupTestDefinitions(self) {
    return Q.all(_.map(self.testGraphs, function(graph) {
        return self.registry.removeGraphDefinition(graph);
    }))
    .then(function() {
        return Q.all(_.map(self.testTasks, function(task) {
            return self.registry.removeTaskDefinition(task);
        }));
    })
    .then(function() {
        self.testTasks = [];
        self.testGraphs = [];
    });
}

describe("Task Graph", function () {
    di.annotate(testJobFactory, new di.Provide('Job.test'));
    di.annotate(testJobFactory, new di.Inject('Job.Base', 'Logger', 'Util', 'uuid'));
    function testJobFactory(BaseJob, Logger, util, uuid) {
        var logger = Logger.initialize(testJobFactory);
        function TestJob(options, context, taskId) {
            options = options || {};
            context = context || {};
            taskId = taskId || uuid.v4();
            TestJob.super_.call(this, logger, options, context, taskId);
        }
        util.inherits(TestJob, BaseJob);

        TestJob.prototype._run = function() {
            var self = this;
            console.log("RUNNING TEST JOB");
            console.log("TEST JOB OPTIONS: " + self.options);
            Q.delay(500).then(function() {
                self._done();
            });
        };

        return TestJob;
    }
    var baseTask = {
        friendlyName: 'Test task',
        injectableName: 'Task.Base.test',
        runJob: 'Job.test',
        requiredOptions: [
            'option1',
            'option2',
            'option3',
        ],
        requiredProperties: {},
        properties: {
            test: {
                type: 'null'
            }
        }
    };
    var testTask = {
        friendlyName: 'Base test task',
        implementsTask: 'Task.Base.test',
        injectableName: 'Task.test',
        options: {
            option1: 1,
            option2: 2,
            option3: 3
        },
        properties: {
            test: {
                foo: 'bar'
            }
        }
    };
    var graphDefinition = {
        friendlyName: 'Test Graph',
        injectableName: 'Graph.test',
        tasks: [
            {
                label: 'test-1',
                taskName: 'Task.test'
            },
            {
                label: 'test-2',
                taskName: 'Task.test',
                waitOn: {
                    'test-1': 'finished'
                }
            }
        ]
    };

    before(function(done) {
        var self = this;

        self.timeout(5000);
        self.injector = helper.baseInjector.createChild(
            _.flatten([
                tasks.injectables,
                helper.require('/lib/task-graph'),
                helper.require('/lib/task-graph-runner'),
                helper.require('/lib/task-graph-subscriptions'),
                helper.require('/lib/service-graph'),
                helper.require('/lib/loader'),
                helper.require('/lib/scheduler'),
                helper.require('/lib/registry'),
                helper.require('/lib/stores/waterline'),
                helper.require('/lib/stores/memory'),
                testJobFactory
            ])
        );
        self.registry = self.injector.get('TaskGraph.Registry');
        self.TaskGraph = self.injector.get('TaskGraph.TaskGraph');
        self.Task = self.injector.get('Task.Task');
        self.loader = self.injector.get('TaskGraph.DataLoader');

        // Don't run service graphs on start in test
        var serviceGraph = self.injector.get('TaskGraph.ServiceGraph');
        serviceGraph.start = sinon.stub();

        return helper.startTaskGraphRunner(self.injector)
        .then(function() {
            return self.loader.loadTasks([baseTask, testTask], self.Task.createRegistryObject);
        })
        .then(function() {
            return self.loader.loadGraphs([graphDefinition], self.TaskGraph.createRegistryObject);
        })
        .then(function() {
            done();
        })
        .catch(function(e) {
            helper.handleError(e);
        });
    });

    after(function() {
        // return this.injector.get('TaskGraph.Runner').stop();
    });

    describe("Validation", function() {
        this.testTasks = [];
        this.testGraphs = [];

        afterEach(function() {
            return cleanupTestDefinitions(this);
        });

        it("should get a base task", function() {
            var graphFactory = this.registry.fetchGraphSync('Graph.test');
            var graph = graphFactory.create();

            var firstTask = graph.definition.tasks[0];
            var taskDefinition = this.registry.fetchTaskSync(firstTask.taskName).definition;

            var baseTaskDefinition = graph._getBaseTask(taskDefinition);

            expect(baseTaskDefinition).to.be.an.object;
            expect(baseTaskDefinition.injectableName).to.equal(taskDefinition.implementsTask);
        });

        it("should validate a task definition", function() {
            var graphFactory = this.registry.fetchGraphSync('Graph.test');
            var graph = graphFactory.create();

            var firstTask = graph.definition.tasks[0];
            var taskDefinition = this.registry.fetchTaskSync(firstTask.taskName).definition;

            expect(function() {
                graph._validateTaskDefinition(taskDefinition);
            }).to.not.throw(Error);

            _.forEach(_.keys(taskDefinition), function(key) {
                expect(function() {
                    var _definition = _.omit(taskDefinition, key);
                    graph._validateTaskDefinition(_definition);
                }).to.throw(Error);
            });

            _.forEach(_.keys(taskDefinition), function(key) {
                expect(function() {
                    var _definition = _.cloneDeep(taskDefinition);
                    // Assert bad types, we won't expect any of our values to be
                    // functions
                    _definition[key] = function() {};
                    graph._validateTaskDefinition(_definition);
                }).to.throw(/required/);
            });
        });

        it("should validate task properties", function() {
            var self = this;

            var baseTask1 = {
                friendlyName: 'base test task properties 1',
                injectableName: 'Task.Base.testProperties1',
                runJob: 'Job.test',
                requiredOptions: [],
                requiredProperties: {},
                properties: {
                    test: {
                        type: 'null'
                    },
                    fresh: {
                        fruit: {
                            slices: 'sugary'
                        }
                    },
                    fried: {
                        chicken: {
                            and: {
                                waffles: 'yum'
                            }
                        }
                    }
                }
            };
            var baseTask2 = {
                friendlyName: 'base test task properties 2',
                injectableName: 'Task.Base.testProperties2',
                runJob: 'Job.test',
                requiredOptions: [],
                requiredProperties: {
                    // test multiple levels of nesting
                    'pancakes': 'syrup',
                    'spam.eggs': 'monty',
                    'fresh.fruit.slices': 'sugary',
                    'fried.chicken.and.waffles': 'yum',
                    'coffee.with.cream.and.sugar': 'wake up'
                },
                properties: {
                    test: {
                        type: 'null'
                    }
                }
            };
            var baseTask3 = {
                friendlyName: 'base test task properties 3',
                injectableName: 'Task.Base.testProperties3',
                runJob: 'Job.test',
                requiredOptions: [],
                requiredProperties: {
                    'does.not.exist': 'negative'
                },
                properties: {
                    test: {
                        type: 'null'
                    }
                }
            };
            var testTask1 = {
                friendlyName: 'test properties task 1',
                implementsTask: 'Task.Base.testProperties1',
                injectableName: 'Task.testProperties1',
                options: {},
                properties: {
                    test: {
                        unit: 'properties',
                    },
                    pancakes: 'syrup',
                    spam: {
                        eggs: 'monty'
                    },
                    coffee: {
                        'with': {
                            cream: {
                                and: {
                                    sugar: 'wake up'
                                }
                            }
                        }
                    }
                }
            };
            var testTask2 = {
                friendlyName: 'test properties task 2',
                implementsTask: 'Task.Base.testProperties2',
                injectableName: 'Task.testProperties2',
                options: {},
                properties: {
                    test: {
                        foo: 'bar'
                    }
                }
            };
            var testTask3 = {
                friendlyName: 'test properties task 3',
                implementsTask: 'Task.Base.testProperties3',
                injectableName: 'Task.testProperties3',
                options: {},
                properties: {
                    test: {
                        bar: 'baz'
                    }
                }
            };
            var graphDefinitionValid = {
                injectableName: 'Graph.testPropertiesValid',
                friendlyName: 'Valid Test Graph',
                tasks: [
                    {
                        label: 'test-1',
                        taskName: 'Task.testProperties1'
                    },
                    {
                        label: 'test-2',
                        taskName: 'Task.testProperties2',
                        waitOn: {
                            'test-1': 'finished'
                        }
                    }
                ]
            };
            var graphDefinitionInvalid = {
                injectableName: 'Graph.testPropertiesInvalid',
                friendlyName: 'Invalid Test Graph',
                tasks: [
                    {
                        label: 'test-1',
                        taskName: 'Task.testProperties1'
                    },
                    {
                        label: 'test-2',
                        taskName: 'Task.testProperties2',
                        waitOn: {
                            'test-1': 'finished'
                        }
                    },
                    {
                        label: 'test-3',
                        taskName: 'Task.testProperties3',
                        waitOn: {
                            'test-2': 'finished'
                        }
                    }
                ]
            };
            return self.loader.loadTasks([
                    baseTask1, baseTask2, baseTask3,
                    testTask1, testTask2, testTask3
                ], self.Task.createRegistryObject)
            .then(function() {
                return self.loader.loadGraphs([graphDefinitionValid, graphDefinitionInvalid],
                        self.TaskGraph.createRegistryObject);
            })
            .catch(function(e) {
                self.testGraphs.push(graphDefinitionValid.injectableName);
                self.testGraphs.push(graphDefinitionInvalid.injectableName);
                self.testTasks = _.map([baseTask1, baseTask2, baseTask3,
                                        testTask1, testTask2, testTask3], function(task) {
                    return task.injectableName;
                });
                helper.handleError(e);
            })
            .then(function() {
                self.testGraphs.push(graphDefinitionValid.injectableName);
                self.testGraphs.push(graphDefinitionInvalid.injectableName);
                self.testTasks = _.map([baseTask1, baseTask2, baseTask3,
                                        testTask1, testTask2, testTask3], function(task) {
                    return task.injectableName;
                });

                var graphFactory = self.registry.fetchGraphSync('Graph.testPropertiesValid');
                var graph = graphFactory.create();

                var firstTask = graph.definition.tasks[0];
                var taskDefinition = self.registry.fetchTaskSync(firstTask.taskName).definition;

                var context = {};
                expect(function() {
                    graph._validateProperties(taskDefinition, context);
                }).to.not.throw(Error);
                expect(context).to.have.property('properties')
                    .that.deep.equals(taskDefinition.properties);

                var secondTask = graph.definition.tasks[1];
                var taskDefinition2 = self.registry.fetchTaskSync(secondTask.taskName).definition;
                expect(function() {
                    graph._validateProperties(taskDefinition2, context);
                }).to.not.throw(Error);

                graphFactory = self.registry.fetchGraphSync('Graph.testPropertiesInvalid');
                var invalidGraph = graphFactory.create();

                var thirdTask = invalidGraph.definition.tasks[2];
                taskDefinition = self.registry.fetchTaskSync(thirdTask.taskName).definition;

                context = {};
                expect(function() {
                    graph._validateProperties(taskDefinition, context);
                }).to.throw(Error);

                _.forEach([baseTask1, baseTask2, baseTask3,
                            testTask1, testTask2, testTask3], function(task) {
                    self.registry.removeTaskSync(task.injectableName);
                });
                _.forEach([graphDefinitionValid, graphDefinitionInvalid], function(graph) {
                    self.registry.removeGraphSync(graph.injectableName);
                });
            }).catch(function(e) {
                helper.handleError(e);
            });
        });

        it("should validate a graph", function() {
            var graphFactory = this.registry.fetchGraphSync('Graph.test');
            var graph = graphFactory.create();

            expect(function() {
                graph.validate();
            }).to.not.throw(Error);
        });

        it("should validate all existing graph definitions not using external options", function() {
            var self = this;
            return self.registry.fetchGraphDefinitionCatalog()
            .then(function(graphs) {
                _.forEach(graphs, function(_graph) {
                    var graph = self.registry.fetchGraphSync(_graph.injectableName).create();
                    if (_.isEmpty(_graph.options)) {
                        expect(function() {
                            graph.validate();
                        }).to.not.throw(Error);
                    }
                });
            });
        });

        it("should validate all existing graph definitions using external options");
    });

    describe("Object Construction", function() {
        before(function() {
            this.testTasks = [];
            this.testGraphs = [];
        });

        afterEach(function() {
            return cleanupTestDefinitions(this);
        });

        it("should render uuids in definition options template values", function() {
            var self = this;
            var assert = self.injector.get('Assert');

            var graphDefinitionRenderUuid = {
                friendlyName: 'Test Render Uuid Graph',
                injectableName: 'Graph.Test.RenderUuid',
                options: {
                    'test-render-task': {
                        option1: '<%=uuid%>',
                        option2: '<%=uuid%>',
                        option3: '<%=uuid%>'
                    },
                },
                tasks: [
                    {
                        label: 'test-render-task',
                        taskName: 'Task.test'
                    }
                ]
            };

            return this.loader.loadGraphs([graphDefinitionRenderUuid],
                    this.TaskGraph.createRegistryObject)
            .catch(function(e) {
                self.testGraphs.push(graphDefinitionRenderUuid.injectableName);
                self.handleError(e);
            })
            .then(function() {
                self.testGraphs.push(graphDefinitionRenderUuid.injectableName);
                var graphFactory = self.registry.fetchGraphSync('Graph.Test.RenderUuid');
                var graph = graphFactory.create({}, {});
                graph._populateTaskData();

                for (var taskId in graph.tasks) break; // jshint ignore: line

                _.forEach(['option1', 'option2', 'option3'], function(option) {
                    expect(function() {
                        assert.uuid(graph.definition.options['test-render-task'][option]);
                        assert.uuid(graph.tasks[taskId].options[option]);
                    }).to.not.throw(Error);
                });
            });
        });

        it("should share context object between tasks and jobs", function() {
            var graphFactory = this.registry.fetchGraphSync('Graph.test');
            var context = { a: 1, b: 2 };
            var graph = graphFactory.create({}, context);

            // Don't worry about checking values because .to.equal checks by reference
            expect(graph).to.have.property('context');
            expect(graph.context).to.equal(context);

            graph._populateTaskData();
            _.forEach(graph.tasks, function(task) {
                expect(task).to.have.property('parentContext');
                expect(task.parentContext).to.equal(context);
                task.instantiateJob();
                expect(task.job.context).to.equal(context);
            });
        });

        it("should populate the dependencies of its tasks", function() {
            var graphFactory = this.registry. fetchGraphSync('Graph.test');
            var graph = graphFactory.create();

            graph._populateTaskData();

            expect(graph.tasks).to.be.ok;
            expect(_.keys(graph.tasks)).to.have.length(2);

            var taskWithDependencies,
                taskWithNoDependencies;

            _.forEach(graph.tasks, function(v) {
                if (_.isEmpty(v.waitingOn)) {
                    taskWithNoDependencies = v;
                } else {
                    taskWithDependencies = v;
                }
            });
            expect(taskWithDependencies).to.be.ok;
            expect(taskWithNoDependencies).to.be.ok;

            expect(taskWithDependencies.instanceId).to.be.a.uuid;
            expect(taskWithNoDependencies.instanceId).to.be.a.uuid;

            expect(taskWithNoDependencies.waitingOn).to.be.empty;
            expect(taskWithDependencies.waitingOn).to.have.property(
                taskWithNoDependencies.instanceId
            ).that.equals('finished');
        });

        it("should apply options to a graph via the registry factory", function() {
            var graphFactory = this.registry. fetchGraphSync('Graph.test');
            expect(graphFactory).to.have.property('create').with.length(2);
            var options = {
                defaults: {
                    a: 1
                }
            };
            var graph = graphFactory.create(options);
            expect(graph.definition.options).to.deep.equal(options);
        });

        it("should apply context to a graph via the registry factory", function() {
            var graphFactory = this.registry. fetchGraphSync('Graph.test');
            var context = {
                target: 'test'
            };
            var graph = graphFactory.create({}, context);
            expect(graph.context).to.deep.equal(context);
        });

        it("should apply options at the graph level to tasks", function() {
            var self = this;
            var firstTask, secondTask, thirdTask;

            var graphDefinitionOptions = {
                injectableName: 'Graph.testGraphOptions',
                friendlyName: 'Test Graph Options',
                options: {
                    defaults: {
                        option1: 'same for all',
                        option2: 'same for all',
                        'optionNonExistant': 'not in any'
                    },
                    'test-2': {
                        overrideOption: 'overridden for test-2',
                        option2: 'overridden default option for test-2'
                    },
                    'test-3': {
                        inlineOptionOverridden: 'overridden inline option for test-3'
                    }
                },
                tasks: [
                    {
                        label: 'test-1',
                        taskName: 'Task.test',
                        optionOverrides: {
                            'testName': 'firstTask'
                        }
                    },
                    {
                        label: 'test-2',
                        taskName: 'Task.test',
                        optionOverrides: {
                            'testName': 'secondTask',
                            overrideOption: undefined
                        },
                        waitOn: {
                            'test-1': 'finished'
                        }
                    },
                    {
                        label: 'test-3',
                        taskDefinition: {
                            friendlyName: 'Test Inline Task',
                            injectableName: 'Task.test.inline-task',
                            implementsTask: 'Task.Base.test',
                            options: {
                                option3: 3,
                                inlineOption: 3,
                                inlineOptionOverridden: undefined,
                                testName: 'thirdTask'
                            },
                            properties: {}
                        }
                    }
                ]
            };

            return this.loader.loadGraphs([graphDefinitionOptions],
                    this.TaskGraph.createRegistryObject)
            .catch(function(e) {
                self.testGraphs.push(graphDefinitionOptions.injectableName);
                helper.handleError(e);
            })
            .then(function() {
                self.testGraphs.push(graphDefinitionOptions.injectableName);
                var graphFactory = self.registry.fetchGraphSync('Graph.testGraphOptions');
                var graph = graphFactory.create();

                // If options will be filled in by the graph, make sure validate
                // doesn't throw if they are missing from the task definition.
                expect(function() {
                    graph.validate();
                }).to.not.throw(Error);

                graph._populateTaskData();

                _.forEach(graph.tasks, function(task) {
                    if (task.definition.options.testName === 'firstTask') {
                        firstTask = task;
                    } else if (task.definition.options.testName === 'secondTask') {
                        secondTask = task;
                    } else if (task.definition.options.testName === 'thirdTask') {
                        thirdTask = task;
                    }
                });

                _.forEach([firstTask, secondTask, thirdTask], function(task) {
                    expect(task).to.have.property('definition');
                    expect(task).to.have.property('options');
                });

                // Assert all default options from the graph get passed down and
                // non-existant options do not get passed down
                expect(firstTask.options).to.have.property('option1').that.equals('same for all');
                expect(firstTask.options).to.have.property('option2').that.equals('same for all');
                expect(firstTask.options).to.have.property('option3').that.equals(3);
                expect(firstTask.options).to.not.have.property('optionNonExistant');

                // Assert that options overridden by task-specific graph options
                // get handed down
                expect(secondTask.options).to.have.property('option1').that.equals('same for all');
                expect(secondTask.options).to.have.property('option2')
                    .that.equals('overridden default option for test-2');
                expect(secondTask.options).to.have.property('option3').that.equals(3);
                expect(secondTask.options).to.have.property('overrideOption')
                    .that.equals('overridden for test-2');
                expect(secondTask.options).to.not.have.property('optionNonExistant');

                // These aren't in the inline definition, so this asserts that we didn't error
                // out on them being missing from options during the requiredOptions check
                expect(thirdTask.options).to.have.property('option1').that.equals('same for all');
                expect(thirdTask.options).to.have.property('option2').that.equals('same for all');
                // Assert that inline task definitions also work with graph options
                expect(thirdTask.options).to.have.property('option3').that.equals(3);
                expect(thirdTask.options).to.have.property('inlineOptionOverridden')
                    .that.equals('overridden inline option for test-3');
                expect(thirdTask.options).to.not.have.property('optionNonExistant');
            })
            .catch(function(e) {
                helper.handleError(e);
            });
        });
    });

    it("should load a task graph data file", function() {
        var graph = this.TaskGraph.create(graphDefinition);

        expect(graph.definition.injectableName).to.equal(graphDefinition.injectableName);
        expect(graph.definition.tasks).to.deep.equal(graphDefinition.tasks);
    });

    it("should find ready tasks", function() {
        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create();
        graph._populateTaskData();

        var taskWithDependencies,
            taskWithNoDependencies;

        _.forEach(graph.tasks, function(v) {
            if (_.isEmpty(v.waitingOn)) {
                taskWithNoDependencies = v;
            } else {
                taskWithDependencies = v;
            }
        });

        graph._findReadyTasks();

        expect(graph.ready).to.not.be.empty;
        expect(graph.ready).to.have.length(1);
        expect(graph.ready[0]).to.equal(taskWithNoDependencies);

        graph.ready.shift();
        taskWithNoDependencies.state = 'succeeded';

        graph._findReadyTasks();
        expect(graph.ready).to.not.be.empty;
        expect(graph.ready).to.have.length(1);
        expect(graph.ready[0]).to.equal(taskWithDependencies);
    });

    it("should run tasks", function(done) {
        this.timeout(5000);
        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create();

        graph.on(graph.completeEventString, function() {
            done();
        });

        graph.start();
    });

    it("should serialize to a JSON object", function() {
        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create();
        graph._populateTaskData();

        literalCompare(graph, graph.serialize());
    });

    it("should serialize a graph with a target as a linked node", function() {
        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create({}, { target: '1234' });
        graph._populateTaskData();

        var output = graph.serialize();
        expect(output).to.have.property('nodes').with.length(1);
        expect(output).to.have.deep.property('nodes[0].id', '1234');
    });

    it("should serialize a graph with a nodeId option as a linked node", function() {
        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create({ nodeId: '4321' }, {});
        graph._populateTaskData();

        var output = graph.serialize();
        expect(output).to.have.property('nodes').with.length(1);
        expect(output).to.have.deep.property('nodes[0].id', '4321');
    });

    it("should serialize a graph with both a target and nodeId as a linked node", function() {
        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create({ nodeId: '1234' }, { target: '1234' });
        graph._populateTaskData();

        var output = graph.serialize();
        expect(output).to.have.property('nodes').with.length(1);
        expect(output).to.have.deep.property('nodes[0].id', '1234');
    });

    it("should serialize a graph with a nodeId option as a linked node", function() {
        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create({ nodeId: '4321' }, { target: '1234' });
        graph._populateTaskData();

        var output = graph.serialize();
        expect(output).to.have.property('nodes').with.length(2);
        expect(output).to.have.deep.property('nodes[0].id', '4321');
        expect(output).to.have.deep.property('nodes[1].id', '1234');
    });

    it("should serialize to a JSON string", function() {
        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create();
        graph._populateTaskData();

        var json = JSON.stringify(graph);
        expect(function() {
            JSON.parse(json);
        }).to.not.throw(Error);
        var parsed = JSON.parse(json);

        deserializeJson(parsed);

        // Do a recursive compare down to non-object values, since lodash and
        // chai deep equality checks do constructor comparisons, which we don't
        // want in this case.
        literalCompare(graph, parsed);
    });

    it("should create a database record for a graph object", function() {
        var waterline = this.injector.get('Services.Waterline');

        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create();
        graph._populateTaskData();

        var serialized = graph.serialize();

        expect(waterline.graphobjects).to.be.ok;
        expect(waterline.graphobjects.create).to.be.a.function;
        return expect(waterline.graphobjects.create(serialized)).to.be.fulfilled;
    });

    it("should create a database record for a graph definition", function() {
        var waterline = this.injector.get('Services.Waterline');

        var graphFactory = this.registry.fetchGraphSync('Graph.test');

        expect(waterline.graphdefinitions).to.be.ok;
        expect(waterline.graphdefinitions.create).to.be.a.function;
        return expect(waterline.graphdefinitions.create(graphFactory.definition)).to.be.fulfilled;
    });

    // The first persist() will do a create, test that
    it("should have correct JSON after first persist in database records for " +
            "serialized graph objects", function() {
        var waterline = this.injector.get('Services.Waterline');

        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create();
        graph._populateTaskData();

        var serialized = graph.serialize();

        return graph.persist()
        .then(function() {
            return waterline.graphobjects.findOne({ instanceId: serialized.instanceId });
        })
        .then(function(record) {
            literalCompare(record.deserialize(), serialized);
        });
    });

    // Subsequent persist() calls will do an update, test that
    it("should have correct JSON after subsequent persists in database records " +
            "for serialized graph objects", function() {
        var waterline = this.injector.get('Services.Waterline');

        var graphFactory = this.registry.fetchGraphSync('Graph.test');
        var graph = graphFactory.create();
        graph._populateTaskData();

        var serialized = graph.serialize();

        return graph.persist()
        .then(function() {
            return waterline.graphobjects.findOne({ instanceId: serialized.instanceId });
        })
        .then(function(record) {
            literalCompare(record.deserialize(), serialized);
        })
        .then(function() {
            graph.testattribute = 'test';
            return graph.persist();
        })
        .then(function() {
            return waterline.graphobjects.findOne({ instanceId: serialized.instanceId });
        })
        .then(function(record) {
            expect(graph.serialize()).to.have.property('testattribute').that.equals('test');
            expect(record.deserialize()).to.have.property('testattribute').that.equals('test');
            literalCompare(record.deserialize(), graph.serialize());
        });
    });
});