#import <UIKit/UIKit.h>

// Owned, offline UIKit query fixture. No networking, credentials, or user data.
@interface BFSDemoController : UIViewController
@property(nonatomic, strong) UITextField *query;
@property(nonatomic, strong) UILabel *results;
@property(nonatomic) NSUInteger queryCount;
#ifdef BFS_CONTROLS
@property(nonatomic, strong) UISwitch *active;
@property(nonatomic, strong) UISegmentedControl *status;
#endif
@end

@implementation BFSDemoController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  self.view.accessibilityIdentifier = @"QueryForm";
  self.query = [[UITextField alloc] init];
  self.query.accessibilityIdentifier = @"Query";
  self.query.placeholder = @"Query";
  self.query.borderStyle = UITextBorderStyleRoundedRect;
  self.query.autocorrectionType = UITextAutocorrectionTypeNo;
  self.query.autocapitalizationType = UITextAutocapitalizationTypeNone;
  self.query.spellCheckingType = UITextSpellCheckingTypeNo;
  self.query.returnKeyType = UIReturnKeySearch;
  UIButton *search = [UIButton buttonWithType:UIButtonTypeSystem];
  search.accessibilityIdentifier = @"Search";
  [search setTitle:@"Search" forState:UIControlStateNormal];
  [search addTarget:self action:@selector(search:) forControlEvents:UIControlEventTouchUpInside];
  self.results = [[UILabel alloc] init];
  self.results.accessibilityIdentifier = @"results";
  self.results.numberOfLines = 0;
  self.results.font = [UIFont systemFontOfSize:22];
  self.results.text = @"RESULT:waiting;COUNT:0";
  #ifdef BFS_CONTROLS
  self.active = [[UISwitch alloc] init];
  self.active.accessibilityIdentifier = @"Active";
  // Keep UISwitch at its UIKit intrinsic width; a filled stack would stretch
  // its accessibility frame across the row while its painted track stays small.
  UIStackView *activeRow = [[UIStackView alloc] initWithArrangedSubviews:@[self.active]];
  activeRow.axis = UILayoutConstraintAxisVertical;
  activeRow.alignment = UIStackViewAlignmentLeading;
  self.status = [[UISegmentedControl alloc] initWithItems:@[@"All", @"Open", @"Closed"]];
  self.status.accessibilityIdentifier = @"StatusGroup";
  self.status.selectedSegmentIndex = 0;
  UIButton *drift = [UIButton buttonWithType:UIButtonTypeSystem];
  drift.accessibilityIdentifier = @"Drift";
  [drift setTitle:@"Change domain" forState:UIControlStateNormal];
  [drift addTarget:self action:@selector(drift:) forControlEvents:UIControlEventTouchUpInside];
  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[self.query, activeRow, self.status, search, self.results, drift]];
#else
  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[self.query, search, self.results]];
#endif
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 24;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor constant:40],
    [stack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:24],
    [stack.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-24],
    [self.query.heightAnchor constraintEqualToConstant:48],
    [search.heightAnchor constraintEqualToConstant:48]
  ]];
}
#ifdef BFS_CONTROLS
- (void)drift:(id)sender {
  [self.status setTitle:@"Replaced" forSegmentAtIndex:1];
}
#endif
- (void)search:(id)sender {
  self.queryCount += 1;
  #ifdef BFS_CONTROLS
  self.results.text = [NSString stringWithFormat:@"RESULT:q=%@;active=%@;status=%@;COUNT:%lu", self.query.text ?: @"", self.active.on ? @"true" : @"false", [self.status titleForSegmentAtIndex:self.status.selectedSegmentIndex], (unsigned long)self.queryCount];
#else
  self.results.text = [NSString stringWithFormat:@"RESULT:q=%@;COUNT:%lu", self.query.text ?: @"", (unsigned long)self.queryCount];
#endif
  [self.query resignFirstResponder];
}
@end

@interface BFSDemoSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation BFSDemoSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  if (![scene isKindOfClass:UIWindowScene.class]) return;
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [[BFSDemoController alloc] init];
  [self.window makeKeyAndVisible];
}
@end
@interface BFSDemoDelegate : UIResponder <UIApplicationDelegate>
@end
@implementation BFSDemoDelegate
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *configuration = [[UISceneConfiguration alloc] initWithName:@"Default Configuration" sessionRole:session.role];
  configuration.delegateClass = BFSDemoSceneDelegate.class;
  return configuration;
}
@end
int main(int argc, char *argv[]) {
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(BFSDemoDelegate.class)); }
}
